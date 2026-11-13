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

// The claimed value (a number, a [min, max] pair, or text) on a row near the claimed box; the nearest one wins.
export function locateValue(claim: { value: number | string | number[]; unit?: string; region: Region }, words: Word[], near = NEAR): { region: Region; text: string } | null {
	let best: { region: Region; text: string; d: number } | null = null
	const consider = (row: Row, start: number, end: number) => {
		const region = union(wordsIn(row, start, end))
		const d = gap(region, claim.region)
		if (d <= near && (!best || d < best.d)) best = { region, text: row.text, d }
	}
	for (const row of toRows(words)) {
		if (typeof claim.value === "string") {
			// Text ("I2S", "QFN-10"): its words in order on one row.
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
			if (first >= 0) consider(row, first, from)
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
			for (let i = 0; i + 1 < nums.length; i++) if (sameNumber(nums[i], a, claim.unit, 0.005) && sameNumber(nums[i + 1], b, claim.unit, 0.005)) consider(row, nums[i].index, end(i + 1))
		} else for (let i = 0; i < nums.length; i++) if (sameNumber(nums[i], claim.value, claim.unit, 0.005)) consider(row, nums[i].index, end(i))
	}
	if (!best) return null
	const { region, text } = best
	return { region, text }
}

// "1 SD, 2 GAIN" (or "1: SD") as pairs in pin-number order: numbers 1..n, each once. Names alone are no pin-out.
export function parsePinPairs(value: string): { number: number; name: string }[] | null {
	const items = value.split(/\s*,\s*/).filter(Boolean)
	const pairs: { number: number; name: string }[] = []
	for (const item of items) {
		const m = /^(\d+)\s*[:=.]?\s+(.+)$|^(\d+)\s*[:=]\s*(.+)$/.exec(item.trim())
		if (!m) return null
		pairs.push({ number: Number(m[1] ?? m[3]), name: plain((m[2] ?? m[4]).trim()) })
	}
	pairs.sort((a, b) => a.number - b.number)
	if (!pairs.length || pairs.some((p, i) => p.number !== i + 1)) return null
	return pairs
}

// A pin-out claimed as number-name pairs, confirmed row by row: each name on a row that also has its number as a number
// of its own (a grid name like "A1" is not pin 1). Tables list pins in any order (by name, by function), with one column
// per package, so the pairs are checked one by one, not as a sequence. Returns the names in pin-number order.
export function locatePins(value: string, words: Word[]): { names: string[]; region: Region; text: string } | null {
	const pairs = parsePinPairs(value)
	if (!pairs) return null
	const rows = toRows(words)
	const regions: Region[] = []
	const texts: string[] = []
	for (const { number, name } of pairs) {
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
	return { names: pairs.map((p) => p.name), region: union(regions), text: texts.join(" | ") }
}
