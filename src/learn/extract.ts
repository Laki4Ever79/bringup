import type { DocStore } from "./docs.ts"
import { fieldsToRead, type KindFile } from "./kinds.ts"
import { gap, locatePins, locateValue, parsePinPairs, type Word } from "./locate.ts"
import { toCanonical, valuesAgree } from "./match.ts"
import { MODELS_LEARN, type PageReader, type ReadRequest } from "./reader.ts"
import type { Fact, LearnedDoc, SourceRef } from "./types.ts"

// A model's claim about one field on one page.
interface Claim {
	field: string
	value: number | string | number[]
	unit?: string
	page: number
	region: SourceRef["region"]
	quote: string
}

const FIRST_TOKENS = 1500
const FOCUSED_TOKENS = 400
const IDENTIFY_TOKENS = 150
// At most this many pages per datasheet: every read costs, and the facts live in a few sections.
export const MAX_PAGES = 8
// The sections facts live in, each wanted once before any is read twice: a long datasheet's pin table, limits,
// characteristics and package drawing, wherever they are.
const SECTIONS: RegExp[] = [
	/pin config|pin description|pin assignment|pin functions|terminal functions|pin-?out/i,
	/absolute maximum/i,
	/recommended operating/i,
	/electrical characteristics|specifications?\b/i,
	/dimension|mechanical|package outline|outline drawing|package drawing|package information/i,
]
// A contents or revision-history page names every section without giving any fact.
const isContents = (t: string) => /table of contents|revision history/i.test(t) || (t.match(/\.{5,}/g) ?? []).length >= 4

// Which pages to read: short documents whole; long ones page 1, then the first page of each section, then more pages of
// those sections, up to MAX_PAGES. Pages with no text (a scan) count as worth reading among the first few.
export async function pagesToRead(doc: LearnedDoc, store: DocStore): Promise<number[]> {
	const all = Array.from({ length: doc.pages }, (_, i) => i + 1)
	if (doc.pages <= MAX_PAGES) return all
	const texts = new Map<number, string>()
	for (const p of all) texts.set(p, await store.textIn(doc, p))
	const useful = (p: number) => !isContents(texts.get(p)!)
	const picked = new Set([1])
	for (const re of SECTIONS) {
		const p = all.find((x) => useful(x) && re.test(texts.get(x)!))
		if (p && picked.size < MAX_PAGES) picked.add(p)
	}
	for (const p of all) {
		if (picked.size >= MAX_PAGES) break
		const t = texts.get(p)!
		if (useful(p) && (SECTIONS.some((re) => re.test(t)) || (t === "" && p <= MAX_PAGES))) picked.add(p)
	}
	return [...picked].sort((a, b) => a - b)
}

// How pins are asked for: number-name pairs, so each can be checked on its own row of a pin table (tables list pins in
// any order).
const PINS_WHAT = 'every numbered pin as "number name", comma-separated, in pin-number order (e.g. "1 SD, 2 GAIN, 3 DIN"); not an exposed or thermal pad. Terminals with names but no numbers (a speaker\'s + and -): the names only, comma-separated, as printed'

// The prompt: values printed on this page only, each with where it is (fractions of the image) and its exact text.
function prompt(kind: KindFile, fields: string[], mpn?: string): string {
	const wanted = fieldsToRead(kind)
		.filter((f) => fields.includes(f.field))
		.map((f) => `- ${f.field}${f.unit ? ` (${f.unit})` : ""}: ${f.field === "pins" ? PINS_WHAT : f.what}`)
	return [
		`This is one page of a datasheet for a part of kind "${kind.kind}"${mpn ? `, part number ${mpn} (where the datasheet covers several versions or packages, report this one's)` : ""}. Report only values printed on this page.`,
		"Fields:",
		...wanted,
		"",
		'Answer with JSON only: {"facts": [{"field", "value", "unit", "region": [x, y, w, h], "quote"}]}.',
		"value: a number, [min, max] for a range, or text.",
		"region: where the value is printed, as fractions (0 to 1) of this image's width and height from its top left.",
		"quote: the value exactly as printed. Leave a field out if this page doesn't give it; never estimate.",
	].join("\n")
}

// The text check needs a region that points at one value: a few lines of one column, not a whole table, where any
// number that happens to be there would "match".
const MAX_TEXT_REGION_AREA = 0.15
const MAX_TEXT_REGION_HEIGHT = 0.1
const pointsAtOneValue = ([, , w, h]: SourceRef["region"]) => w * h <= MAX_TEXT_REGION_AREA && h <= MAX_TEXT_REGION_HEIGHT

const isRegion = (r: unknown): r is SourceRef["region"] => Array.isArray(r) && r.length === 4 && r.every((x) => typeof x === "number" && x >= 0 && x <= 1)
const isValue = (v: unknown): v is Claim["value"] => typeof v === "number" || (typeof v === "string" && v.trim() !== "") || (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number"))

function claims(json: unknown, page: number, fields: string[]): Claim[] {
	const facts = (json as { facts?: unknown })?.facts
	if (!Array.isArray(facts)) return []
	const out: Claim[] = []
	for (const f of facts as Record<string, unknown>[]) {
		if (typeof f?.field !== "string" || !fields.includes(f.field) || !isValue(f.value) || !isRegion(f.region)) continue
		if (f.field === "pins" && typeof f.value !== "string") continue
		out.push({ field: f.field, value: f.value, unit: typeof f.unit === "string" && f.unit ? f.unit : undefined, page, region: f.region, quote: typeof f.quote === "string" ? f.quote : String(f.value) })
	}
	return out
}

// A little margin around the claimed region, so a box drawn tight on the digits still holds them.
const pad = ([x, y, w, h]: SourceRef["region"], m = 0.01): SourceRef["region"] => {
	const x0 = Math.max(0, x - m)
	const y0 = Math.max(0, y - m)
	return [x0, y0, Math.min(1, x + w + m) - x0, Math.min(1, y + h + m) - y0]
}

// In the kind's unit when it's the same quantity ("0.087 in" for a field in mm becomes 2.2098 mm).
function inKindUnit(c: Claim, kind: KindFile): { value: Claim["value"]; unit?: string } {
	const unit = fieldsToRead(kind).find((f) => f.field === c.field)?.unit
	if (!unit || !c.unit || c.unit === unit) return { value: c.value, unit: c.unit ?? unit }
	const one = toCanonical(1, unit)
	const conv = (v: number) => {
		const x = toCanonical(v, c.unit)
		return x.unit === one.unit ? Number((x.value / one.value).toPrecision(6)) : null
	}
	if (typeof c.value === "number") {
		const v = conv(c.value)
		return v === null ? { value: c.value, unit: c.unit } : { value: v, unit }
	}
	if (Array.isArray(c.value)) {
		const v = c.value.map(conv)
		return v.every((x) => x !== null) ? { value: v as number[], unit } : { value: c.value, unit: c.unit }
	}
	return { value: c.value, unit: c.unit }
}

// Reads every chosen page with the cheap model, then confirms each field independently: its value among the page's own
// words near where the model says it is (the region becomes those words' box), or, where nothing is printed there (an
// image-only page, a raster drawing), a second read that agrees; anything else goes to the strong model once. A field
// nothing confirms is left out: the missing-value rule (rule.ts) decides what happens to it. stats.firstRead counts the
// facts the cheap model's first read gave without the strong model (what tunes the model choice); stats.pages the pages
// read.
export async function extractFacts(doc: LearnedDoc, kind: KindFile, deps: { store: DocStore; reader: PageReader; mpn?: string; stats?: { firstRead: number; pages?: number } }): Promise<Fact[]> {
	const { store, reader } = deps
	// The footprint is never taken from a datasheet's words: it comes from a land-pattern library and is checked against
	// the pins (footprint.ts). The package name read here is only a hint for that search.
	const toRead = fieldsToRead(kind)
	const fields = toRead.map((f) => f.field)
	const images = new Map<number, Buffer>()
	const image = async (p: number) => images.get(p) ?? images.set(p, await store.renderPage(doc, p)).get(p)!
	const pageWords = new Map<number, Word[]>()
	const wordsOf = async (p: number) => pageWords.get(p) ?? pageWords.set(p, await store.words(doc, p)).get(p)!

	const read = async (page: number, fs: string[], pass: ReadRequest["meta"]["pass"]): Promise<Claim[]> => {
		const model = pass === "strong" ? MODELS_LEARN.strong : MODELS_LEARN.cheap
		const r = await reader.read({ model, prompt: prompt(kind, fs, deps.mpn), images: [await image(page)], maxTokens: pass === "first" ? FIRST_TOKENS : FOCUSED_TOKENS, meta: { page, fields: fs, pass } })
		return claims(r.json, page, fs)
	}

	const candidates = new Map<string, Claim[]>()
	const pages = await pagesToRead(doc, store)
	if (deps.stats) deps.stats.pages = (deps.stats.pages ?? 0) + pages.length
	for (const page of pages) {
		for (const c of await read(page, fields, "first")) candidates.set(c.field, [...(candidates.get(c.field) ?? []), c])
	}

	// Pins are stored as names in pin-number order; the quote and region are the page's own, never the model's.
	const fact = (c: Claim, check: Fact["check"], found?: { region: SourceRef["region"]; text: string }): Fact => {
		const pairs = c.field === "pins" && typeof c.value === "string" ? parsePinPairs(c.value) : null
		return {
			field: c.field,
			...(pairs ? { value: pairs.map((p) => p.name).join(",") } : inKindUnit(c, kind)),
			status: "datasheet",
			critical: false,
			source: { doc: doc.id, page: c.page, region: found?.region ?? c.region, quote: found ? found.text.replace(/\s+/g, " ").trim().slice(0, 160) : c.quote },
			check,
		}
	}

	// Pins given as number-name pairs: each pair on its own row anywhere on the page (pin tables list pins in any order).
	const pairsOf = (c: Claim) => c.field === "pins" && typeof c.value === "string" && parsePinPairs(c.value) !== null
	// The claim among the page's words: pin pairs pair by pair anywhere on the page, any other value (terminal names
	// without numbers included, as one sequence) near its claimed region. A region too big to point at one value finds
	// nothing: any number in a whole table would "match".
	const locate = (c: Claim, words: Word[]) => {
		if (pairsOf(c)) {
			const hit = locatePins(String(c.value), words)
			return hit && { region: hit.region, text: hit.text }
		}
		return pointsAtOneValue(c.region) ? locateValue(c, words) : null
	}

	async function confirm(c: Claim): Promise<{ fact: Fact; strong: boolean } | null> {
		const words = await wordsOf(c.page)
		const hit = locate(c, words)
		if (hit) return { fact: fact(c, "text", hit), strong: false }
		// Nothing printed where the value is claimed (an image-only page, or a raster drawing on a page with text): only
		// independent reads can confirm it.
		const drawn = !words.length || (!pairsOf(c) && pointsAtOneValue(c.region) && !words.some((w) => gap(w.region, pad(c.region)) === 0))
		if (drawn) {
			const second = (await read(c.page, [c.field], "second")).find((x) => x.field === c.field)
			if (second && valuesAgree(c, second)) return { fact: fact(c, "two-reads"), strong: false }
			const strong = (await read(c.page, [c.field], "strong")).find((x) => x.field === c.field)
			if (strong && (valuesAgree(strong, c) || (second && valuesAgree(strong, second)))) return { fact: fact(strong, "two-reads"), strong: true }
			return null
		}
		const strong = (await read(c.page, [c.field], "strong")).find((x) => x.field === c.field)
		const strongHit = strong ? locate(strong, words) : null
		return strong && strongHit ? { fact: fact(strong, "text", strongHit), strong: true } : null
	}

	const out: Fact[] = []
	for (const field of fields) {
		for (const c of candidates.get(field) ?? []) {
			const r = await confirm(c)
			if (r) {
				out.push(r.fact)
				if (!r.strong && deps.stats) deps.stats.firstRead++
				break
			}
		}
	}
	return out
}

// Is this datasheet for the kind of part needed at all? One cheap read of page 1, before any facts are read: a
// candidate the proposer got wrong (an amplifier IC for a loudspeaker) then costs one call, not a whole datasheet. Only
// a clear "no" rejects it.
export async function identifyPart(doc: LearnedDoc, kind: KindFile, mpn: string, deps: { store: DocStore; reader: PageReader }): Promise<{ matches: boolean; part?: string }> {
	const r = await deps.reader.read({
		model: MODELS_LEARN.cheap,
		prompt: [
			`This is page 1 of the datasheet found for part number ${mpn}.`,
			`The part needed is ${kind.description ?? `a part of kind "${kind.kind}"`}.`,
			'Is the part this datasheet describes that kind of part? Answer with JSON only: {"matches": true or false, "part": what the part is, in a few words}.',
		].join("\n"),
		images: [await deps.store.renderPage(doc, 1)],
		maxTokens: IDENTIFY_TOKENS,
		meta: { page: 1, fields: [], pass: "identify" },
	})
	const j = r.json as { matches?: unknown; part?: unknown } | null
	return j?.matches === false ? { matches: false, ...(typeof j.part === "string" ? { part: j.part } : {}) } : { matches: true }
}
