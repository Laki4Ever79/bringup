import type { DocStore } from "./docs.ts"
import type { KindFile } from "./kinds.ts"
import { toCanonical, valueMatches, valuesAgree } from "./match.ts"
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
// Long datasheets: the first pages (summary, pin-out, electrical tables) plus pages that name the sections the facts
// live in, up to this many.
const MAX_PAGES = 12
const SECTION_RE = /dimension|mechanical|package outline|outline drawing|pin config|pin description|pin assignment|absolute maximum|electrical characteristics|recommended operating/i

// Which pages to read. Short documents whole; long ones by section titles, so a 60-page datasheet costs 12 reads.
export async function pagesToRead(doc: LearnedDoc, store: DocStore): Promise<number[]> {
	const all = Array.from({ length: doc.pages }, (_, i) => i + 1)
	if (doc.pages <= 10) return all
	const picked = all.slice(0, 6)
	for (const p of all.slice(6)) {
		if (picked.length >= MAX_PAGES) break
		if (SECTION_RE.test(await store.textIn(doc, p))) picked.push(p)
	}
	return picked
}

// The prompt: values printed on this page only, each with where it is (fractions of the image) and its exact text.
function prompt(kind: KindFile, fields: string[]): string {
	const wanted = kind.fields.filter((f) => fields.includes(f.field)).map((f) => `- ${f.field}${f.unit ? ` (${f.unit})` : ""}: ${f.what}`)
	return [
		`This is one page of a datasheet for a part of kind "${kind.kind}". Report only values printed on this page.`,
		"Fields:",
		...wanted,
		"",
		'Answer with JSON only: {"facts": [{"field", "value", "unit", "region": [x, y, w, h], "quote"}]}.',
		"value: a number, [min, max] for a range, or text (pins: names in pin-number order, comma-separated).",
		"region: where the value is printed, as fractions (0 to 1) of this image's width and height from its top left.",
		"quote: the value exactly as printed. Leave a field out if this page doesn't give it; never estimate.",
	].join("\n")
}

const isRegion = (r: unknown): r is SourceRef["region"] => Array.isArray(r) && r.length === 4 && r.every((x) => typeof x === "number" && x >= 0 && x <= 1)
const isValue = (v: unknown): v is Claim["value"] => typeof v === "number" || (typeof v === "string" && v.trim() !== "") || (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number"))

function claims(json: unknown, page: number, fields: string[]): Claim[] {
	const facts = (json as { facts?: unknown })?.facts
	if (!Array.isArray(facts)) return []
	const out: Claim[] = []
	for (const f of facts as Record<string, unknown>[]) {
		if (typeof f?.field !== "string" || !fields.includes(f.field) || !isValue(f.value) || !isRegion(f.region)) continue
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
	const unit = kind.fields.find((f) => f.field === c.field)?.unit
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

// Reads every chosen page with the cheap model, then confirms each field independently: its value in the page's text
// at the claimed region, or (an image-only page) a second read that agrees; a disagreement goes to the strong model
// once. A field nothing confirms is left out: the missing-value rule (rule.ts) decides what happens to it.
export async function extractFacts(doc: LearnedDoc, kind: KindFile, deps: { store: DocStore; reader: PageReader }): Promise<Fact[]> {
	const { store, reader } = deps
	const fields = kind.fields.map((f) => f.field)
	const images = new Map<number, Buffer>()
	const image = async (p: number) => images.get(p) ?? images.set(p, await store.renderPage(doc, p)).get(p)!
	const pageText = new Map<number, string>()
	const textOf = async (p: number) => pageText.get(p) ?? pageText.set(p, await store.textIn(doc, p)).get(p)!

	const read = async (page: number, fs: string[], pass: ReadRequest["meta"]["pass"]): Promise<Claim[]> => {
		const model = pass === "strong" ? MODELS_LEARN.strong : MODELS_LEARN.cheap
		const r = await reader.read({ model, prompt: prompt(kind, fs), images: [await image(page)], maxTokens: pass === "first" ? FIRST_TOKENS : FOCUSED_TOKENS, meta: { page, fields: fs, pass } })
		return claims(r.json, page, fs)
	}

	const candidates = new Map<string, Claim[]>()
	for (const page of await pagesToRead(doc, store)) {
		for (const c of await read(page, fields, "first")) candidates.set(c.field, [...(candidates.get(c.field) ?? []), c])
	}

	const fact = (c: Claim, check: Fact["check"]): Fact => ({
		field: c.field,
		...inKindUnit(c, kind),
		status: "datasheet",
		critical: false,
		source: { doc: doc.id, page: c.page, region: c.region, quote: c.quote },
		check,
	})

	async function confirm(c: Claim): Promise<Fact | null> {
		const imageOnly = (await textOf(c.page)) === ""
		if (imageOnly) {
			const second = (await read(c.page, [c.field], "second")).find((x) => x.field === c.field)
			if (second && valuesAgree(c, second)) return fact(c, "two-reads")
			const strong = (await read(c.page, [c.field], "strong")).find((x) => x.field === c.field)
			if (strong && (valuesAgree(strong, c) || (second && valuesAgree(strong, second)))) return fact(strong, "two-reads")
			return null
		}
		if (valueMatches(c, await store.textIn(doc, c.page, pad(c.region)))) return fact(c, "text")
		const strong = (await read(c.page, [c.field], "strong")).find((x) => x.field === c.field)
		if (strong && valueMatches(strong, await store.textIn(doc, strong.page, pad(strong.region)))) return fact(strong, "text")
		return null
	}

	const out: Fact[] = []
	for (const field of fields) {
		for (const c of candidates.get(field) ?? []) {
			const f = await confirm(c)
			if (f) {
				out.push(f)
				break
			}
		}
	}
	return out
}
