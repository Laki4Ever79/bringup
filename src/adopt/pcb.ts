// Reads any KiCad board (5 through 9) into the facts adopt needs: the outline's bounding box and every footprint with
// its pads, each pad's net and pin name. Unlike tools/kicad-read.ts it assumes nothing about who drew the board.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
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
	// The pads' extent in board axes (rotation applied), a stand-in for the part's body: enough to size a cutout.
	size: { w: number; h: number }
}

export interface Board {
	outline: { widthMm: number; heightMm: number; minX: number; minY: number } | null
	footprints: Footprint[]
	// KiCad file format version, e.g. 20211014 (6), 20171130 (5).
	version: number
	// Board thickness from the file's general section (1.6 when absent).
	thicknessMm: number
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
		const corners: [number, number][] = []
		for (const p of e) {
			if (head(p) !== "pad") continue
			const pad = p as Sexp[]
			// (net 5 "name") through KiCad 8, (net "name") from 9.
			const netE = child(pad, "net")
			const net = netE ? String(netE[netE.length - 1]) : ""
			const raw = child(pad, "pinfunction")?.[1]
			let fn = typeof raw === "string" ? raw : ""
			// KiCad 10 writes the pin name with the pad number after it (PC13_2 for pin PC13 on pad 2).
			if (version >= 20251000 && fn.endsWith(`_${pad[1]}`)) fn = fn.slice(0, -`_${pad[1]}`.length)
			pads.push({ number: String(pad[1]), net, fn })
			const [px = 0, py = 0] = nums(child(pad, "at"))
			const [sw = 0, sh = 0] = nums(child(pad, "size"))
			corners.push([px - sw / 2, py - sh / 2], [px + sw / 2, py + sh / 2])
		}
		const span = (k: 0 | 1) => (corners.length ? Math.max(...corners.map((c) => c[k])) - Math.min(...corners.map((c) => c[k])) : 0)
		const turned = Math.round(((rot % 180) + 180) % 180) === 90
		const size = { w: +(turned ? span(1) : span(0)).toFixed(2), h: +(turned ? span(0) : span(1)).toFixed(2) }
		footprints.push({ ref: textOf(e, "reference"), value: textOf(e, "value"), lib: String(e[1]), x, y, rot, pads, size })
	}
	const thickness = Number(child(child(board, "general") ?? [], "thickness")?.[1])
	return { outline, footprints, version, thicknessMm: Number.isFinite(thickness) && thickness > 0 ? thickness : 1.6 }
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

// KiCad 6+ boards whose pads lost their pin names (often converted from KiCad 5): each .kicad_sch embeds every symbol
// it uses (lib_symbols, with each pin's name and number) and places them by lib_id with a Reference. Joins the two
// and fills in each unnamed pad's fn. Returns how many pads it named.
export function nameFromSchematics(b: Board, schTexts: string[]): number {
	const pinsOf = new Map<string, Map<string, string>>()
	const libOf = new Map<string, string>()
	const collect = (e: Sexp[], into: Map<string, string>) => {
		for (const c of e) {
			if (!Array.isArray(c)) continue
			if (head(c) === "pin") {
				const name = child(c, "name")?.[1]
				const number = child(c, "number")?.[1]
				if (typeof name === "string" && typeof number === "string" && name !== "~") into.set(number, name)
			} else if (head(c) === "symbol") collect(c, into)
		}
	}
	for (const text of schTexts) {
		const sch = (parse(text).find((e) => head(e) === "kicad_sch") as Sexp[] | undefined) ?? []
		for (const sym of child(sch, "lib_symbols") ?? []) {
			if (head(sym) !== "symbol" || typeof (sym as Sexp[])[1] !== "string") continue
			const pins = new Map<string, string>()
			collect(sym as Sexp[], pins)
			pinsOf.set((sym as Sexp[])[1] as string, pins)
		}
		for (const e of sch) {
			if (head(e) !== "symbol") continue
			const lib = child(e as Sexp[], "lib_id")?.[1]
			const ref = (e as Sexp[]).find((c) => Array.isArray(c) && c[0] === "property" && c[1] === "Reference") as Sexp[] | undefined
			if (typeof lib === "string" && typeof ref?.[2] === "string") libOf.set(ref[2], lib)
		}
	}
	let named = 0
	for (const f of b.footprints) {
		const pins = pinsOf.get(libOf.get(f.ref) ?? "")
		if (!pins) continue
		for (const p of f.pads)
			if (!p.fn && pins.has(p.number)) {
				p.fn = pins.get(p.number)!
				named++
			}
	}
	return named
}

// A board file as adopt reads it: parsed, and its unnamed pads named from the project's schematics (KiCad 5: the
// schematic and symbol cache; KiCad 6+: the symbols each .kicad_sch embeds).
export function loadBoardFile(file: string): Board {
	const b = readBoard(readFileSync(file, "utf8"))
	const dir = dirname(file)
	const cache = join(dir, `${basename(file, ".kicad_pcb")}-cache.lib`)
	if (b.version < 20200000 && existsSync(cache)) {
		const schs = readdirSync(dir).filter((n) => n.endsWith(".sch")).map((n) => readFileSync(join(dir, n), "utf8"))
		nameLegacyPads(b, schs, readFileSync(cache, "utf8"))
	}
	// Only when a part with many pads has none named: reading schematics costs time on big projects.
	const unnamed = b.footprints.some((f) => f.pads.length >= 8 && f.pads.every((p) => !p.fn))
	if (b.version >= 20200000 && unnamed) {
		const schs = readdirSync(dir).filter((n) => n.endsWith(".kicad_sch")).map((n) => readFileSync(join(dir, n), "utf8"))
		if (schs.length) nameFromSchematics(b, schs)
	}
	return b
}
