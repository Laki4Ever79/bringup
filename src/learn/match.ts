// Does a number the model says it read actually appear in the datasheet's text? Whole numbers only ("2.2" never
// matches "22" or "12.2"), in their written forms (comma decimals, Ø, ranges, inches), compared in canonical units.

// Unit spellings → canonical unit and factor. Longest spellings first, so "mm" isn't read as "m", "mA" not as "m".
const UNITS: [string, string, number][] = [
	["cm³", "L", 0.001],
	["cm3", "L", 0.001],
	["kHz", "Hz", 1000],
	["Hz", "Hz", 1],
	["kΩ", "Ω", 1000],
	["kohm", "Ω", 1000],
	["ohms", "Ω", 1],
	["ohm", "Ω", 1],
	["Ω", "Ω", 1],
	["mm", "mm", 1],
	["cm", "mm", 10],
	["inch", "mm", 25.4],
	["in", "mm", 25.4],
	['"', "mm", 25.4],
	["″", "mm", 25.4],
	["mV", "V", 0.001],
	["V", "V", 1],
	["µA", "mA", 0.001],
	["μA", "mA", 0.001],
	["uA", "mA", 0.001],
	["mA", "mA", 1],
	["A", "mA", 1000],
	["mW", "W", 0.001],
	["W", "W", 1],
	["MB", "MB", 1],
	["L", "L", 1],
	["F", "F", 1],
]
const UNIT_BY_NAME = new Map(UNITS.map(([name, canon, f]) => [name, { canon, f }]))

export function toCanonical(value: number, unit?: string): { value: number; unit?: string } {
	if (!unit) return { value }
	const u = UNIT_BY_NAME.get(unit) ?? UNIT_BY_NAME.get(unit.toLowerCase())
	return u ? { value: value * u.f, unit: u.canon } : { value, unit }
}

export interface ParsedNumber {
	value: number
	unit?: string
	raw: string
	// Joined to the number before it by a range separator ("2.5–5.5", "3.0 ~ 3.6", "-0.3 to 6.0").
	rangeEnd?: boolean
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
// A unit right after a number, ending where a word would (so "8 Ohm" but not "8 Ampere-hours" as "A").
const UNIT_RE = new RegExp(`^\\s?(${UNITS.map(([n]) => esc(n)).join("|")})(?![A-Za-z])`)
// A number: optional sign (only where it can't be a range dash), digits with one decimal point or comma, or a leading
// decimal point (".087").
const NUM_RE = /(\d*[.,]\d+|\d+)/g
const RANGE_SEP = /^\s*(?:[-–—~]|to)\s*$/

export function parseNumbers(text: string): ParsedNumber[] {
	const out: ParsedNumber[] = []
	let last = -1
	for (const m of text.matchAll(NUM_RE)) {
		const start = m.index!
		const prev = text[start - 1]
		// Part of a longer token (a letter or digit run like "QFN10", "GPIO8") is no reading.
		if (prev && /[A-Za-z_]/.test(prev) && !/[ØΦ⌀]/.test(prev)) continue
		let raw = m[1]
		// "1,000" (comma then exactly three digits, no more) is a thousands separator; "2,2" is a decimal comma.
		const thousands = /^\d{1,3},\d{3}$/.test(raw) && !/[\d]/.test(text[start + raw.length] ?? "")
		let value = Number(thousands ? raw.replace(",", "") : raw.replace(",", "."))
		const between = last >= 0 ? text.slice(last, start) : ""
		const rangeEnd = out.length > 0 && RANGE_SEP.test(between)
		// A minus directly before the number is a sign unless it separates a range from the number before it.
		const signChar = text[start - 1]
		if ((signChar === "-" || signChar === "−") && !rangeEnd) {
			value = -value
			raw = `-${raw}`
		}
		const after = text.slice(start + m[1].length)
		const u = UNIT_RE.exec(after)
		const n: ParsedNumber = { value, raw, ...(u ? { unit: u[1] } : {}), ...(rangeEnd ? { rangeEnd: true } : {}) }
		// "2.5–5.5 V": the range's start takes its end's unit.
		if (rangeEnd && n.unit && out.at(-1) && !out.at(-1)!.unit) out.at(-1)!.unit = n.unit
		out.push(n)
		last = start + m[1].length + (u ? u[0].length : 0)
	}
	return out
}

const close = (a: number, b: number, relTol: number) => Math.abs(a - b) <= relTol * Math.max(Math.abs(b), 1e-9)

function sameNumber(n: ParsedNumber, value: number, unit: string | undefined, relTol: number): boolean {
	const want = toCanonical(value, unit)
	const got = toCanonical(n.value, n.unit)
	// Both carry units: they must be the same quantity. A bare number (a drawing's dimension) compares by value.
	if (want.unit && got.unit && want.unit !== got.unit) return false
	return close(got.value, want.value, relTol)
}

// True when the fact's value (or, for a [min, max] fact, its two ends in order) is written in the text.
export function valueMatches(fact: { value: number | string | number[]; unit?: string }, text: string, relTol = 0.005): boolean {
	const nums = parseNumbers(text)
	if (Array.isArray(fact.value)) {
		const [a, b] = fact.value
		return nums.some((n, i) => i + 1 < nums.length && sameNumber(n, a, fact.unit, relTol) && sameNumber(nums[i + 1], b, fact.unit, relTol))
	}
	if (typeof fact.value === "string") return text.toLowerCase().includes(fact.value.toLowerCase())
	return nums.some((n) => sameNumber(n, fact.value as number, fact.unit, relTol))
}
