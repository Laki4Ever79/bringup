import { execFile } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { KICAD_IMAGE } from "../tools/env.ts"
import type { Fact } from "./types.ts"

const run = promisify(execFile)

// Where a board part's land pattern comes from (plan 1 records the source and checks it against the pin-out; plan 2
// converts it for tscircuit and checks pad sizes against the datasheet's land pattern). First the part's EasyEDA
// footprint by its LCSC id (the endpoint easyeda2kicad uses), then a KiCad standard-library footprint named for the
// package. Either counts only when its pads match the pins, allowing one exposed pad.
const EASYEDA = (lcsc: string) => `https://easyeda.com/api/products/${encodeURIComponent(lcsc)}/components?version=6.4.19.5`

const padsFit = (pads: number, pins: number) => pads === pins || pads === pins + 1

// A KiCad footprint name read as a package: "QFN-10-1EP_3x3mm_P0.5mm" → QFN, 10 pins, an exposed pad, a 3 × 3 mm body.
// A family with a number of its own keeps it ("SOT-23-5" → SOT-23, 5 pins). Names without a pin count (R_0402) → null.
export function kicadPackage(name: string): { family: string; count: number; ep: boolean; size?: [number, number] } | null {
	const base = name.split("_")[0]
	const ep = /-1EP$/.test(base)
	const m = /^([A-Za-z][A-Za-z0-9]*(?:-\d+(?=-\d))?)-(\d+)$/.exec(base.replace(/-1EP$/, ""))
	if (!m) return null
	const size = /_(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)mm/.exec(name)
	return { family: m[1].toUpperCase(), count: Number(m[2]), ep, ...(size ? { size: [Number(size[1]), Number(size[2])] as [number, number] } : {}) }
}

// "QFN-10-1EP_3x3mm_P0.5mm" → 11, "SOIC-8_3.9x4.9mm" → 8; names without a pin count (R_0402) → null.
export function kicadPadCount(name: string): number | null {
	const p = kicadPackage(name)
	return p ? p.count + (p.ep ? 1 : 0) : null
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
// An exposed pad named in how the datasheet prints the package (TI's PowerPAD, a thermal pad), or an H-family (HVSSOP).
const NAMES_EP = /POWER\s*PAD|THERMAL|EXPOSED|(^|[^A-Z])EP([^A-Z]|$)/
const SIZE_TOL_MM = 0.25

// A KiCad standard-library footprint for a package as a datasheet or a listing prints it ("8-Pin HVSSOP", "MSOP-8
// PowerPAD (DGN)"): the library's own family names found in that text, the pin count from the pin-out (and the text's
// own count when it gives one), the body size from the datasheet's outline when known. Among several, the one whose
// size is known to match, then the one with or without an exposed pad as the text says, then the plainest name (no
// thermal-via or mask variant).
function kicadFor(packageName: string, pinCount: number, bodyMm: number[] | undefined, index: string[]): string | null {
	const text = packageName.toUpperCase()
	const entries = index.map((e) => ({ e, p: kicadPackage(e.split(":")[1] ?? e) })).filter((x): x is { e: string; p: NonNullable<ReturnType<typeof kicadPackage>> } => x.p !== null)
	const families = [...new Set(entries.map((x) => x.p.family))].sort((a, b) => b.length - a.length)
	const named = new Map<string, number | null>()
	for (const f of families) {
		const m = new RegExp(`(?<![A-Z0-9])${esc(f)}(?![A-Z])(?:-(\\d+))?`).exec(text)
		if (!m || [...named.keys()].some((k) => k.includes(f))) continue
		const pinsWord = /(\d+)\s*-?\s*PIN/.exec(text)
		named.set(f, m[1] ? Number(m[1]) : pinsWord ? Number(pinsWord[1]) : null)
	}
	const wantsEp = NAMES_EP.test(text) || [...named.keys()].some((f) => f.startsWith("H"))
	const body = bodyMm && bodyMm.length >= 2 ? [bodyMm[0], bodyMm[1]] : null
	const sizeOk = (s: [number, number]) => body !== null && ((Math.abs(s[0] - body[0]) <= SIZE_TOL_MM && Math.abs(s[1] - body[1]) <= SIZE_TOL_MM) || (Math.abs(s[0] - body[1]) <= SIZE_TOL_MM && Math.abs(s[1] - body[0]) <= SIZE_TOL_MM))
	const fits = entries.filter(({ p }) => named.has(p.family) && (named.get(p.family) ?? p.count) === p.count && padsFit(p.count + (p.ep ? 1 : 0), pinCount) && !(body && p.size && !sizeOk(p.size)))
	const score = ({ e, p }: (typeof fits)[number]) => [p.size && sizeOk(p.size) ? 0 : 1, p.ep === wantsEp ? 0 : 1, e.length] as const
	fits.sort((a, b) => {
		const [x, y] = [score(a), score(b)]
		return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
	})
	return fits[0]?.e ?? null
}

export async function findFootprint(part: { lcsc?: string; packageName?: string; pins: string[]; bodyMm?: number[] }, deps: { fetchImpl: typeof fetch; kicadIndex?: string[] }): Promise<Fact | null> {
	if (!part.pins.length) return null
	if (part.lcsc) {
		try {
			const url = EASYEDA(part.lcsc)
			const res = await deps.fetchImpl(url, { signal: AbortSignal.timeout(15_000) })
			if (res.ok) {
				const body = (await res.json()) as { result?: { packageDetail?: { title?: string; dataStr?: { shape?: string[] } } } }
				const shapes = body.result?.packageDetail?.dataStr?.shape ?? []
				const pads = shapes.filter((s) => s.startsWith("PAD~")).length
				if (pads && padsFit(pads, part.pins.length)) {
					return { field: "footprint", value: `easyeda:${part.lcsc}`, status: "datasheet", critical: true, check: "pad-count", origin: url.split("?")[0] }
				}
			}
		} catch {
			// No EasyEDA answer: try the KiCad library.
		}
	}
	if (part.packageName && deps.kicadIndex?.length) {
		const hit = kicadFor(part.packageName, part.pins.length, part.bodyMm, deps.kicadIndex)
		if (hit) return { field: "footprint", value: `kicad:${hit}`, status: "datasheet", critical: true, check: "pad-count", origin: `KiCad standard library ${hit}` }
	}
	return null
}

// Every footprint in the KiCad image's standard library as "Library:Name", listed once and cached.
export async function kicadFootprintIndex(root: string): Promise<string[]> {
	const file = join(root, ".cache/learn/kicad-footprints.txt")
	if (existsSync(file)) return readFileSync(file, "utf8").split("\n").filter(Boolean)
	try {
		const { stdout } = await run("docker", ["run", "--rm", KICAD_IMAGE, "find", "/usr/share/kicad/footprints", "-name", "*.kicad_mod"], { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 })
		const index = stdout
			.split("\n")
			.map((p) => /footprints\/([^/]+)\.pretty\/(.+)\.kicad_mod$/.exec(p))
			.filter((m): m is RegExpExecArray => m !== null)
			.map((m) => `${m[1]}:${m[2]}`)
		mkdirSync(join(root, ".cache/learn"), { recursive: true })
		writeFileSync(file, index.join("\n"))
		return index
	} catch {
		return []
	}
}
