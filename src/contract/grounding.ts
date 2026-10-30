import type { CatalogPart } from "../tools/parts-search.ts"
import type { ContractSnapshot, Part } from "./types.ts"

export interface KicadSymbol {
	pins: { name: string; number: string }[]
	keywords: string[]
}

export interface GroundingFinding {
	partRef: string
	kind: "unknown-part" | "unknown-pin" | "pin-not-on-part"
	detail: string
	source: "catalog" | "kicad" | "none"
}

type Sexpr = string | Sexpr[]

// Minimal S-expression reader for .kicad_sym: lists, quoted strings with backslash escapes, and bare atoms.
function readSexpr(text: string): Sexpr[] {
	const root: Sexpr[] = []
	const stack: Sexpr[][] = [root]
	let i = 0
	while (i < text.length) {
		const ch = text[i]
		if (ch === "(") {
			const list: Sexpr[] = []
			stack[stack.length - 1].push(list)
			stack.push(list)
			i++
		} else if (ch === ")") {
			if (stack.length > 1) stack.pop()
			i++
		} else if (ch === '"') {
			let s = ""
			i++
			while (i < text.length && text[i] !== '"') {
				if (text[i] === "\\" && i + 1 < text.length) i++
				s += text[i++]
			}
			stack[stack.length - 1].push(s)
			i++
		} else if (/\s/.test(ch)) {
			i++
		} else {
			const start = i
			while (i < text.length && !/[\s()"]/.test(text[i])) i++
			stack[stack.length - 1].push(text.slice(start, i))
		}
	}
	return root
}

const isList = (x: Sexpr): x is Sexpr[] => Array.isArray(x)
const children = (list: Sexpr[], head: string) => list.filter(isList).filter((c) => c[0] === head)

// "~{RST}" is KiCad's overbar markup; the pin is RST.
const plainName = (name: string) => name.replace(/~\{([^}]*)\}/g, "$1")

function collectPins(list: Sexpr[], out: KicadSymbol["pins"]) {
	for (const pin of children(list, "pin")) {
		const name = children(pin, "name")[0]?.[1]
		const number = children(pin, "number")[0]?.[1]
		if (typeof name === "string" && typeof number === "string") out.push({ name: plainName(name), number })
	}
	// Pins live in unit sub-symbols such as "SHT4x_1_1".
	for (const unit of children(list, "symbol")) collectPins(unit, out)
}

// Top-level symbols of a KiCad symbol library, with pins resolved through `extends`.
export function parseKicadSymbols(sexpr: string): Record<string, KicadSymbol> {
	const lib = readSexpr(sexpr).find(isList) ?? []
	const own: Record<string, KicadSymbol & { parent?: string }> = {}
	for (const sym of children(lib, "symbol")) {
		const name = sym[1]
		if (typeof name !== "string") continue
		const pins: KicadSymbol["pins"] = []
		collectPins(sym, pins)
		const kw = children(sym, "property").find((p) => p[1] === "ki_keywords")?.[2]
		const parent = children(sym, "extends")[0]?.[1]
		own[name] = { pins, keywords: typeof kw === "string" ? kw.split(/\s+/).filter(Boolean) : [], parent: typeof parent === "string" ? parent : undefined }
	}
	const resolved: Record<string, KicadSymbol> = {}
	for (const [name, sym] of Object.entries(own)) {
		let pins = sym.pins
		const seen = new Set([name])
		for (let p = sym.parent; pins.length === 0 && p && own[p] && !seen.has(p); p = own[p].parent) {
			seen.add(p)
			pins = own[p].pins
		}
		resolved[name] = { pins, keywords: sym.keywords }
	}
	return resolved
}

// Finds the KiCad symbol for an MPN: exact name, then the longest name the MPN starts with ("AP2112K-3.3" for
// "AP2112K-3.3TRG1"), then a lowercase-x wildcard ("SHT4x"), then a ki_keywords entry ("SHT40").
// Names without a digit (R, LED, Battery) are generic and never match by prefix.
export function matchSymbol(mpn: string, symbols: Record<string, KicadSymbol>): string | null {
	const m = mpn.toUpperCase()
	const names = Object.keys(symbols)
	const longest = (hits: string[]) => hits.sort((a, b) => b.length - a.length)[0] ?? null
	const specific = (s: string) => s.length >= 4 && /\d/.test(s)
	const exact = names.find((n) => n.toUpperCase() === m)
	if (exact) return exact
	const prefix = longest(names.filter((n) => specific(n) && m.startsWith(n.toUpperCase())))
	if (prefix) return prefix
	const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const wildcard = longest(
		names.filter((n) => n.includes("x") && specific(n) && new RegExp(`^${n.split("x").map((s) => escape(s.toUpperCase())).join("[A-Z0-9]")}`).test(m)),
	)
	if (wildcard) return wildcard
	return longest(names.filter((n) => symbols[n].keywords.some((k) => specific(k) && m.startsWith(k.toUpperCase()))))
}

interface Truth {
	source: "catalog" | "kicad"
	label: string
	pins: Set<string>
}

function truthFor(part: Part, catalog: CatalogPart[], symbols: Record<string, KicadSymbol>): Truth | null {
	const entry = catalog.find((c) => c.mpn.toUpperCase() === part.mpn.toUpperCase())
	if (entry && entry.pins.length > 0) return { source: "catalog", label: `catalog ${entry.mpn}`, pins: new Set(entry.pins.map((p) => p.toUpperCase())) }
	const name = matchSymbol(part.mpn, symbols)
	if (name && symbols[name].pins.length > 0) {
		const pins = new Set(symbols[name].pins.flatMap((p) => [p.name.toUpperCase(), p.number.toUpperCase()]))
		return { source: "kicad", label: `KiCad symbol ${name}`, pins }
	}
	if (entry) return { source: "catalog", label: `catalog ${entry.mpn}`, pins: new Set() }
	return null
}

// Checks every part's pins and every pin assignment against the catalog, then KiCad's symbol library.
// A claim with nothing behind it is a finding, so invented pinouts never reach the board or the firmware.
export function groundParts(s: ContractSnapshot, sources: { catalog: CatalogPart[]; symbols?: Record<string, KicadSymbol> }): GroundingFinding[] {
	const findings: GroundingFinding[] = []
	const parts = s.values.parts ?? []
	const truths = new Map<string, Truth | null>()

	const checkPin = (part: Part, truth: Truth, pin: string, claim: string) => {
		if (truth.pins.size === 0) {
			findings.push({ partRef: part.ref, kind: "unknown-pin", detail: `${claim} ${pin}, but ${truth.label} lists no pins to check it against`, source: truth.source })
		} else if (!truth.pins.has(pin.toUpperCase())) {
			findings.push({ partRef: part.ref, kind: "pin-not-on-part", detail: `${claim} ${pin}, which ${truth.label} (${part.mpn}) does not have`, source: truth.source })
		}
	}

	for (const part of parts) {
		const truth = truthFor(part, sources.catalog, sources.symbols ?? {})
		truths.set(part.ref, truth)
		if (!truth) {
			findings.push({ partRef: part.ref, kind: "unknown-part", detail: `${part.mpn} is in neither the catalog nor the KiCad symbol library`, source: "none" })
			continue
		}
		for (const pin of part.pins) checkPin(part, truth, pin, `${part.ref} lists pin`)
	}

	const mcu = parts.find((p) => p.role === "mcu")
	for (const a of s.values.pins ?? []) {
		const part = parts.find((p) => p.ref === a.partRef)
		if (!part) {
			findings.push({ partRef: a.partRef, kind: "unknown-part", detail: `${a.signal} is assigned to ${a.partRef}, which is not in the contract's parts`, source: "none" })
			continue
		}
		const truth = truths.get(part.ref)
		if (truth) checkPin(part, truth, a.partPin, `${a.signal} uses ${a.partRef} pin`)
		const mcuTruth = mcu && truths.get(mcu.ref)
		if (mcu && mcuTruth && mcuTruth.pins.size > 0 && !mcuTruth.pins.has(`GPIO${a.gpio}`) && !mcuTruth.pins.has(`IO${a.gpio}`)) {
			findings.push({ partRef: mcu.ref, kind: "pin-not-on-part", detail: `${a.signal} is on GPIO${a.gpio}, which ${mcuTruth.label} (${mcu.mpn}) does not have`, source: mcuTruth.source })
		}
	}
	return findings
}
