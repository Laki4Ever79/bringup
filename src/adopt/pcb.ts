// Reads any KiCad board (5 through 9) into the facts adopt needs: the outline's bounding box and every footprint with
// its pads, each pad's net and pin name. Unlike tools/kicad-read.ts it assumes nothing about who drew the board.
import { parse, type Sexp } from "../tools/kicad-read.ts"

export interface Pad {
	number: string
	net: string
	// The symbol's pin name (KiCad 6+ writes it as pinfunction); "" on KiCad 5 boards.
	fn: string
}

export interface Footprint {
	ref: string
	value: string
	lib: string
	x: number
	y: number
	rot: number
	pads: Pad[]
}

export interface Board {
	outline: { widthMm: number; heightMm: number; minX: number; minY: number } | null
	footprints: Footprint[]
	// KiCad file format version, e.g. 20211014 (6), 20171130 (5).
	version: number
}

const head = (e: Sexp): string | undefined => (Array.isArray(e) && typeof e[0] === "string" ? e[0] : undefined)
const child = (e: Sexp[], name: string) => e.find((c) => head(c) === name) as Sexp[] | undefined
const nums = (e: Sexp[] | undefined) => (e ?? []).slice(1).map(Number)

function textOf(fp: Sexp[], kind: "reference" | "value"): string {
	const Kind = kind === "reference" ? "Reference" : "Value"
	const e = fp.find((c) => Array.isArray(c) && ((c[0] === "property" && c[1] === Kind) || (c[0] === "fp_text" && c[1] === kind))) as Sexp[] | undefined
	return typeof e?.[2] === "string" ? e[2] : ""
}

export function readBoard(text: string): Board {
	const board = (parse(text).find((e) => head(e) === "kicad_pcb") as Sexp[] | undefined) ?? []
	const version = Number(child(board, "version")?.[1] ?? 0)

	const xs: number[] = []
	const ys: number[] = []
	for (const e of board) {
		if (!Array.isArray(e) || !head(e)?.startsWith("gr_") || child(e, "layer")?.[1] !== "Edge.Cuts") continue
		const pts = [...["start", "end", "mid"].map((k) => child(e, k)), ...(child(e, "pts") ?? []).filter((p) => head(p) === "xy")]
		for (const p of pts) {
			if (!p) continue
			const [x, y] = nums(p as Sexp[])
			xs.push(x)
			ys.push(y)
		}
		// A circle's bounding box: centre ± radius (gr_circle has center and end on the rim).
		if (head(e) === "gr_circle") {
			const [cx, cy] = nums(child(e, "center"))
			const [ex, ey] = nums(child(e, "end"))
			const r = Math.hypot(ex - cx, ey - cy)
			xs.push(cx - r, cx + r)
			ys.push(cy - r, cy + r)
		}
	}
	const r3 = (n: number) => +n.toFixed(3)
	const outline = xs.length
		? { widthMm: r3(Math.max(...xs) - Math.min(...xs)), heightMm: r3(Math.max(...ys) - Math.min(...ys)), minX: Math.min(...xs), minY: Math.min(...ys) }
		: null

	const footprints: Footprint[] = []
	for (const e of board) {
		// KiCad 5 calls a footprint a module.
		if (!Array.isArray(e) || (head(e) !== "footprint" && head(e) !== "module")) continue
		const [x, y, rot = 0] = nums(child(e, "at"))
		const pads: Pad[] = []
		for (const p of e) {
			if (head(p) !== "pad") continue
			const pad = p as Sexp[]
			// (net 5 "name") through KiCad 8, (net "name") from 9.
			const netE = child(pad, "net")
			const net = netE ? String(netE[netE.length - 1]) : ""
			const fn = child(pad, "pinfunction")?.[1]
			pads.push({ number: String(pad[1]), net, fn: typeof fn === "string" ? fn : "" })
		}
		footprints.push({ ref: textOf(e, "reference"), value: textOf(e, "value"), lib: String(e[1]), x, y, rot, pads })
	}
	return { outline, footprints, version }
}

// Every pad on each net, so an unnamed net can still say what it connects to.
export function netMembers(b: Board): Map<string, { ref: string; pad: string; fn: string }[]> {
	const m = new Map<string, { ref: string; pad: string; fn: string }[]>()
	for (const f of b.footprints)
		for (const p of f.pads) {
			if (!p.net) continue
			if (!m.has(p.net)) m.set(p.net, [])
			m.get(p.net)!.push({ ref: f.ref, pad: p.number, fn: p.fn })
		}
	return m
}

// KiCad 5 boards don't store pin names on pads. The project still has them: each .sch names every reference's symbol
// ("L ESP32Modules:TTGO_TDisplay U1") and <project>-cache.lib holds every symbol's pins ("X IO25 7 ..." = name, number).
// Joins the two and fills in each pad's fn. Returns how many pads it named.
export function nameLegacyPads(b: Board, schTexts: string[], cacheLib: string): number {
	const pinsOf = new Map<string, Map<string, string>>()
	let cur: Map<string, string> | null = null
	for (const line of cacheLib.split("\n")) {
		const def = /^DEF\s+(\S+)/.exec(line)
		if (def) pinsOf.set(def[1].replace(/^~/, ""), (cur = new Map()))
		else if (line.startsWith("ENDDEF")) cur = null
		else if (cur) {
			const x = /^X\s+(\S+)\s+(\S+)\s/.exec(line)
			if (x && x[1] !== "~") cur.set(x[2], x[1])
		}
	}
	const symbolOf = new Map<string, string>()
	for (const sch of schTexts)
		for (const m of sch.matchAll(/^L\s+(\S+)\s+(\S+)\s*$/gm)) symbolOf.set(m[2], m[1].replace(":", "_"))
	let named = 0
	for (const f of b.footprints) {
		const pins = pinsOf.get(symbolOf.get(f.ref) ?? "")
		if (!pins) continue
		for (const p of f.pads)
			if (!p.fn && pins.has(p.number)) {
				p.fn = pins.get(p.number)!
				named++
			}
	}
	return named
}
