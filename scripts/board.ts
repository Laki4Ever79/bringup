// Build one contract's board at a given size and say whether it routes (13 Nov 2026: the same throwaway script got
// written three times while testing placement). Uses the real board build (tscircuit, its layout retries, KiCad DRC)
// and the consistency checks, and prints only what matters: the verdict, the first real error, DRC errors by type.
//
//   npm run board -- <contract.json> [WxH] [--no-debug-port] [--keep]
//
// The contract must be a full one (a run's contract.json): a scripted design copied into a fixture by hand may lack
// what a run fills in (an MCU with pins: [] builds as "U1 has no ports").
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { checkConsistency } from "../src/contract/consistency.ts"
import { connectorsAt, minimumBoard } from "../src/contract/space.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { buildBoard } from "../src/tools/board.ts"
import { detectEnvironment } from "../src/tools/env.ts"

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith("--") && !/^\d+(\.\d+)?x\d+(\.\d+)?$/.test(a))
const size = args.find((a) => /^\d+(\.\d+)?x\d+(\.\d+)?$/.test(a))
if (!file) {
	console.error("usage: npm run board -- <contract.json> [WxH] [--no-debug-port] [--keep]")
	process.exit(2)
}
const s0 = JSON.parse(readFileSync(resolve(file), "utf8")) as ContractSnapshot
const outline = s0.values.outline
if (!outline) throw new Error(`${file}: the contract has no outline`)
const [w, h] = size ? size.split("x").map(Number) : [outline.widthMm, outline.heightMm]
const mcu = s0.values.parts?.find((p) => p.role === "mcu")
if (mcu && mcu.pins.length === 0) console.warn(`warning: ${mcu.ref} (${mcu.mpn}) lists no pins: tscircuit will give it no ports. Use a run's contract.json.`)
const { sizeReason: _r, ...rest } = outline
const s: ContractSnapshot = {
	...s0,
	values: {
		...s0.values,
		outline: { ...rest, widthMm: w, heightMm: h, ...(size ? {} : _r ? { sizeReason: _r } : {}) },
		connectors: connectorsAt(s0, w, h),
		...(args.includes("--no-debug-port") ? { requirements: { ...s0.values.requirements!, debugPort: false } } : {}),
	},
}
const min = minimumBoard(s)
console.log(`${file} at ${w}×${h} mm${min ? ` (smallest by placement: ${min.widthMm}×${min.heightMm} mm)` : ""}`)
const env = await detectEnvironment(resolve(import.meta.dirname, ".."))
const dir = mkdtempSync(join(tmpdir(), "bringup-board-cli-"))
const t0 = Date.now()
try {
	const board = await buildBoard(env, dir, s, s.revision ?? 1)
	const v = checkConsistency(s, { board }).filter((x) => !x.kind.startsWith("space"))
	const drc = board.drc
	const errs = drc ? Object.entries(drc.byType).filter(([k]) => !/lib_footprint|text_height|silk/.test(k)) : []
	console.log(`ROUTED in ${Math.round((Date.now() - t0) / 1000)} s · DRC ${drc ? `${drc.errors} errors${drc.firstError ? ` (first: ${drc.firstError})` : ""}` : "not run"}`)
	if (errs.length) console.log(`  DRC by type: ${errs.map(([k, n]) => `${k} ${n}`).join(", ")}`)
	if (board.debugPortDropped) console.log(`  debug footprint left off: ${board.debugPortDropped}`)
	console.log(v.length ? `  violations: ${v.map((x) => `${x.kind}: ${x.message.split("\n")[0]}`).join("\n              ")}` : "  consistency: clean")
	if (args.includes("--keep")) console.log(`  board: ${board.dir}`)
	process.exitCode = v.length || (drc?.errors ?? 0) ? 1 : 0
} catch (e) {
	console.log(`FAILED in ${Math.round((Date.now() - t0) / 1000)} s`)
	console.log(String(e).split("\n").filter((l) => l.trim() && !/^\s*at /.test(l)).slice(0, 10).map((l) => `  ${l}`).join("\n"))
	process.exitCode = 1
} finally {
	if (!args.includes("--keep")) rmSync(dir, { recursive: true, force: true })
}
