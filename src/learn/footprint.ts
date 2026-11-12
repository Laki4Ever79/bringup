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

// "QFN-10-1EP_3x3mm" → 11, "SOIC-8_3.9x4.9mm" → 8; names without a pin count (R_0402) → null.
export function kicadPadCount(name: string): number | null {
	const m = /^[A-Za-z]+[A-Za-z0-9]*?-(\d+)(-1EP)?(?:[_-]|$)/.exec(name)
	return m ? Number(m[1]) + (m[2] ? 1 : 0) : null
}

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "")

export async function findFootprint(part: { lcsc?: string; packageName?: string; pins: string[] }, deps: { fetchImpl: typeof fetch; kicadIndex?: string[] }): Promise<Fact | null> {
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
		const want = norm(part.packageName)
		const hit = deps.kicadIndex.find((entry) => {
			const name = entry.split(":")[1] ?? entry
			const count = kicadPadCount(name)
			return norm(name).startsWith(want) && count !== null && padsFit(count, part.pins.length)
		})
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
