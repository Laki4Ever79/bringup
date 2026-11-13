import { parseNumbers, sameNumber } from "./match.ts"
import type { SourceRef } from "./types.ts"

// Where a value the model claims is printed, found among the page's own words (pdftotext -bbox). The model's box only
// says roughly where to look: vision models place boxes loosely, so the value is searched for near it and the fact's
// region becomes the words' own box, which the evidence page and the overlay can trust.
export type Region = SourceRef["region"]
export interface Word {
	text: string
	region: Region
}

interface Row {
	text: string
	// Each word's start and end in text.
	spans: { word: Word; start: number; end: number }[]
}

// How far (in page fractions) a value may be from the box the model drew around it: about two table rows.
export const NEAR = 0.03

// Unicode minus and dashes as the plain hyphen pin names are written with ("VO−" is "VO-").
const plain = (s: string) => s.replace(/[−–—]/g, "-")

const union = (rs: Region[]): Region => {
	const x0 = Math.min(...rs.map((r) => r[0]))
	const y0 = Math.min(...rs.map((r) => r[1]))
	const x1 = Math.max(...rs.map((r) => r[0] + r[2]))
	const y1 = Math.max(...rs.map((r) => r[1] + r[3]))
	return [x0, y0, x1 - x0, y1 - y0]
}

// Distance between two boxes (0 when they touch or overlap), the larger of the horizontal and vertical gaps.
export const gap = (a: Region, b: Region) => Math.max(0, a[0] - (b[0] + b[2]), b[0] - (a[0] + a[2]), a[1] - (b[1] + b[3]), b[1] - (a[1] + a[3]))

// Two words' vertical overlap as a share of the shorter one's height.
const overlap = (a: Region, b: Region) => Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1])) / Math.max(1e-9, Math.min(a[3], b[3]))
// Closer than this (a page fraction, under a point) a word continues the one before it: a subscript or superscript, as
// in "V" + "DD" for VDD, which pdftotext gives as two words.
const TOUCH = 0.0015

// Words on one printed line, left to right: words overlapping the line's first word by at least 40 % of their height
// (a subscript sits lower but still overlaps its letter). A word touching the one before it joins it with no space.
function toRows(words: Word[]): Row[] {
	const sorted = [...words].sort((a, b) => a.region[1] + a.region[3] / 2 - (b.region[1] + b.region[3] / 2))
	const groups: Word[][] = []
	for (const w of sorted) {
		const last = groups.at(-1)
		if (last && overlap(last[0].region, w.region) >= 0.4) last.push(w)
		else groups.push([w])
	}
	return groups.map((g) => {
		const spans: Row["spans"] = []
		let text = ""
		let prev: Word | null = null
		for (const word of g.sort((a, b) => a.region[0] - b.region[0])) {
			if (text && !(prev && word.region[0] - (prev.region[0] + prev.region[2]) < TOUCH)) text += " "
			prev = word
			spans.push({ word, start: text.length, end: text.length + word.text.length })
			text += plain(word.text)
		}
		return { text, spans }
	})
}

const wordsIn = (row: Row, start: number, end: number) => row.spans.filter((s) => s.end > start && s.start < end).map((s) => s.word.region)

interface Occurrence {
	row: Row
	region: Region
}

// Every place the claimed value is printed: a number (in its unit), a [min, max] pair as two numbers in a row, or text
// ("I2S", "QFN-10") as its words in order on one row.
function occurrences(claim: { value: number | string | number[]; unit?: string }, rows: Row[]): Occurrence[] {
	const out: Occurrence[] = []
	const add = (row: Row, start: number, end: number) => out.push({ row, region: union(wordsIn(row, start, end)) })
	for (const row of rows) {
		if (typeof claim.value === "string") {
			const parts = plain(claim.value).split(/\s*[,;]\s*|\s+/).filter(Boolean)
			let from = 0
			let first = -1
			for (const t of parts) {
				const m = new RegExp(`(^|[^A-Za-z0-9_])(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?=$|[^A-Za-z0-9_])`, "i").exec(row.text.slice(from))
				if (!m) {
					first = -2
					break
				}
				const at = from + m.index + m[1].length
				if (first === -1) first = at
				from = at + m[2].length
			}
			if (first >= 0) add(row, first, from)
			continue
		}
		const nums = parseNumbers(row.text)
		// A number's end, its unit included when one is written right after it ("5.5 V").
		const end = (i: number) => {
			const e = nums[i].index + nums[i].raw.replace(/^-/, "").length
			const u = nums[i].unit
			const at = u ? row.text.indexOf(u, e) : -1
			return u && at >= 0 && at - e <= 1 ? at + u.length : e
		}
		if (Array.isArray(claim.value)) {
			const [a, b] = claim.value
			for (let i = 0; i + 1 < nums.length; i++) if (sameNumber(nums[i], a, claim.unit, 0.005) && sameNumber(nums[i + 1], b, claim.unit, 0.005)) add(row, nums[i].index, end(i + 1))
		} else for (let i = 0; i < nums.length; i++) if (sameNumber(nums[i], claim.value, claim.unit, 0.005)) add(row, nums[i].index, end(i))
	}
	return out
}

// Is the value printed anywhere on the page? If not, it can only be in a drawing or an image.
export function printedOnPage(claim: { value: number | string | number[]; unit?: string }, words: Word[]): boolean {
	return occurrences(claim, toRows(words)).length > 0
}

const rowMid = (r: Row) => r.spans[0].word.region[1] + r.spans[0].word.region[3] / 2
const rowHeight = (r: Row) => Math.max(...r.spans.map((s) => s.word.region[3]))
const labelTokens = (label: string) => plain(label).toLowerCase().split(/[^a-z0-9+-]+/).filter((t) => t.length >= 2 && !/^\d+$/.test(t))
// A label's row or the next one: a table's label cell often sits between the rows of its conditions.
const LABEL_ROWS = 1.8

// Where the claimed value is printed. By its label first: the parameter's name as printed ("Supply voltage"), with the
// value on that row or the next (in label-row heights), the nearest one winning; the region then runs from the label to
// the value. Vision models place boxes loosely (off by a column or more in run 5), so the model's box only breaks ties.
// Without a label found, the value must be within `near` of the model's box.
export function locateValue(claim: { value: number | string | number[]; unit?: string; label?: string; region: Region }, words: Word[], near = NEAR): { region: Region; text: string } | null {
	const rows = toRows(words)
	const found = occurrences(claim, rows)
	if (!found.length) return null
	const tokens = claim.label ? labelTokens(claim.label) : []
	if (tokens.length) {
		let best: { region: Region; text: string; d: number; g: number } | null = null
		for (const lr of rows) {
			const words = lr.text.toLowerCase().split(/[^a-z0-9+-]+/)
			if (!tokens.every((t) => words.includes(t))) continue
			const labelWords = lr.spans.filter((s) => tokens.includes(s.word.text.toLowerCase().replace(/[^a-z0-9+-]/g, ""))).map((s) => s.word.region)
			for (const o of found) {
				const d = Math.abs(rowMid(o.row) - rowMid(lr)) / rowHeight(lr)
				if (d > LABEL_ROWS) continue
				const g = gap(o.region, claim.region)
				if (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) < 1e-9 && g < best.g)) best = { region: union([...labelWords, o.region]), text: o.row === lr ? lr.text : `${lr.text} | ${o.row.text}`, d, g }
			}
		}
		if (best) return { region: best.region, text: best.text }
	}
	let best: { o: Occurrence; d: number } | null = null
	for (const o of found) {
		const d = gap(o.region, claim.region)
		if (d <= near && (!best || d < best.d)) best = { o, d }
	}
	return best ? { region: best.o.region, text: best.o.row.text } : null
}

// A pin-out as pairs: the numbers given, and the ones a pin table leaves out (unconnected pins it doesn't list) as NC,
// at most a few of them; null when it isn't number-name pairs.
function pinPairs(value: string): { pairs: { number: number; name: string }[]; given: Set<number> } | null {
	const items = value.split(/\s*,\s*/).filter(Boolean)
	const given = new Map<number, string>()
	for (const item of items) {
		const m = /^(\d+)\s*[:=.]?\s+(.+)$|^(\d+)\s*[:=]\s*(.+)$/.exec(item.trim())
		if (!m) return null
		const n = Number(m[1] ?? m[3])
		if (n < 1 || given.has(n)) return null
		given.set(n, plain((m[2] ?? m[4]).trim()))
	}
	if (!given.size) return null
	const max = Math.max(...given.keys())
	if (max - given.size > Math.max(2, Math.floor(max / 4))) return null
	return { pairs: Array.from({ length: max }, (_, i) => ({ number: i + 1, name: given.get(i + 1) ?? "NC" })), given: new Set(given.keys()) }
}

// "1 SD, 2 GAIN" (or "1: SD") as pairs in pin-number order, numbers a pin table doesn't list filled in as NC. Names
// alone are no pin-out.
export function parsePinPairs(value: string): { number: number; name: string }[] | null {
	return pinPairs(value)?.pairs ?? null
}

// A pin-out claimed as number-name pairs, confirmed row by row: each name on a row that also has its number as a number
// of its own (a grid name like "A1" is not pin 1). Tables list pins in any order (by name, by function), with one column
// per package, so the pairs are checked one by one, not as a sequence. Pins filled in as NC are not checked. Returns the
// names in pin-number order.
export function locatePins(value: string, words: Word[]): { names: string[]; region: Region; text: string } | null {
	const parsed = pinPairs(value)
	if (!parsed) return null
	const rows = toRows(words)
	const regions: Region[] = []
	const texts: string[] = []
	for (const { number, name } of parsed.pairs) {
		// Filled in, or called unconnected by the model itself: tables leave such pins out.
		if (!parsed.given.has(number) || /^(NC|N\/C|DNC)$/i.test(name)) continue
		const re = new RegExp(`(^|[^A-Za-z0-9_])(${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?=$|[^A-Za-z0-9_+\\-])`, "i")
		const row = rows.find((r) => {
			const m = re.exec(r.text)
			return m !== null && parseNumbers(r.text).some((n) => n.value === number && n.raw === String(number))
		})
		if (!row) return null
		const m = re.exec(row.text)!
		const at = m.index + m[1].length
		const n = parseNumbers(row.text).find((x) => x.value === number && x.raw === String(number))!
		regions.push(union([...wordsIn(row, at, at + m[2].length), ...wordsIn(row, n.index, n.index + n.raw.length)]))
		if (!texts.includes(row.text)) texts.push(row.text)
	}
	// Nothing checked (every pin NC) proves nothing.
	if (!regions.length) return null
	return { names: parsed.pairs.map((p) => p.name), region: union(regions), text: texts.join(" | ") }
}
