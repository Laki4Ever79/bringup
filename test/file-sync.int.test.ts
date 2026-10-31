import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT, runDesign } from "../src/run.ts"
import { detectEnvironment } from "../src/tools/env.ts"
import { tempDir, waitFor } from "./helpers.ts"
import { widenBoard } from "./kicad-edit.ts"

const env = await detectEnvironment(ROOT)
const skip = env.tsci && env.kicad && env.python && env.pio ? false : "a hardware tool is missing"

const trace = (out: string) => readFileSync(join(out, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))

test("editing the board outline in a --stay run's board.kicad_pcb becomes an engineer change, and the board and case follow", { skip, timeout: 1_200_000 }, async () => {
	const out = tempDir()
	let end: () => void = () => {}
	const until = new Promise<void>((r) => (end = r))
	const run = runDesign({ brief: readFileSync(join(ROOT, "briefs/logger.md"), "utf8"), mock: true, outDir: out, env, stay: { until } })
	try {
		await waitFor(() => existsSync(join(out, "trace.jsonl")) && trace(out).some((e) => e.type === "design.settled"), 900_000)
		const revs = readdirSync(join(out, "board")).filter((d) => existsSync(join(out, "board", d, "dist/board/kicad/board.kicad_pcb"))).map((d) => Number(d.slice(4)))
		const rev = Math.max(...revs)
		const pcb = join(out, "board", `rev-${rev}`, "dist/board/kicad/board.kicad_pcb")
		writeFileSync(pcb, widenBoard(readFileSync(pcb, "utf8"), 5))
		await waitFor(() => trace(out).some((e) => e.type === "change.requested"), 20_000)
		const req = trace(out).find((e) => e.type === "change.requested")!
		assert.equal(req.payload.text, "edited board.kicad_pcb: outline 50×30 → 55×30 mm")
		assert.equal(req.payload.source.path, `board/rev-${rev}/dist/board/kicad/board.kicad_pcb`)
		const n = trace(out).indexOf(trace(out).find((e) => e.type === "change.requested"))
		await waitFor(() => trace(out).slice(n).some((e) => e.type === "design.settled"), 900_000)
		const contract = JSON.parse(readFileSync(join(out, "contract.json"), "utf8"))
		assert.equal(contract.values.outline.widthMm, 55)
		const [row] = JSON.parse(readFileSync(join(out, "ripples.json"), "utf8")).requests
		assert.deepEqual(row.fieldsChanged, ["outline"])
		assert.ok(row.woke.includes("build:board") && row.woke.includes("build:enclosure") && !row.woke.includes("build:firmware"), JSON.stringify(row))
		assert.equal(typeof row.durationMs, "number")
	} finally {
		end()
		await run
	}
})
