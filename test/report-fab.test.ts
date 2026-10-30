import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import type { BoardArtifact } from "../src/contract/consistency.ts"
import { writeReport } from "../src/report.ts"
import { BringupState } from "../src/runtime.ts"
import type { Env } from "../src/tools/env.ts"
import { tempDir } from "./helpers.ts"

const env: Env = { root: ".", tsci: "tsci", kicad: "docker", python: "python", pio: "pio" }

function board(extra: Partial<BoardArtifact>): BoardArtifact {
	return { revision: 3, dir: "/b", pcbPath: "/b/board.kicad_pcb", stepPath: null, renderPath: null, widthMm: 50, heightMm: 30, nets: {}, ...extra }
}

function report(s: BringupState, opts: { noHardware?: boolean } = {}): string {
	return readFileSync(writeReport(s.outDir, s, env, true, opts), "utf8")
}

test("report lists the fab package files", () => {
	const s = new BringupState(tempDir())
	const fabDir = join(s.outDir, "board", "rev-3", "fab")
	mkdirSync(fabDir, { recursive: true })
	for (const f of ["gerbers.zip", "bom.csv", "cpl.csv", "README.txt"]) writeFileSync(join(fabDir, f), "x")
	s.artifacts.board = board({ fabDir })
	const text = report(s)
	assert.match(text, /## Fabrication/)
	for (const f of ["gerbers.zip", "bom.csv", "cpl.csv", "README.txt"]) assert.match(text, new RegExp(`- ${f.replace(".", "\\.")}`))
	assert.match(text, /checklist/i)
})

test("report says when the fab export failed, without failing the board", () => {
	const s = new BringupState(tempDir())
	s.artifacts.board = board({ fabError: "kicad-cli pcb export failed (exit 1): no such layer\nmore detail" })
	const text = report(s)
	assert.match(text, /Fab export failed: kicad-cli pcb export failed \(exit 1\): no such layer$/m)
	assert.doesNotMatch(text, /more detail/)
})

test("report says fab was skipped under --no-hardware", () => {
	const s = new BringupState(tempDir())
	assert.match(report(s, { noHardware: true }), /Fab export: skipped \(--no-hardware/)
})

test("report shows the sourcing summary from bom.json, and says when there is none", () => {
	const s = new BringupState(tempDir())
	writeFileSync(join(s.outDir, "bom.json"), JSON.stringify({ revision: 1, totalUsd: 5, items: [], readiness: { summary: "18/18 listed at LCSC/JLCPCB · 2 stock confirmed · 16 stock unknown (jlcsearch returned none)", warn: false } }))
	assert.match(report(s), /^- Sourcing: 18\/18 listed at LCSC\/JLCPCB · 2 stock confirmed · 16 stock unknown \(jlcsearch returned none\)$/m)
	writeFileSync(join(s.outDir, "bom.json"), JSON.stringify({ revision: 1, totalUsd: null, items: [], readiness: { summary: "1/2 listed at LCSC/JLCPCB · 1 out of stock (D1)", warn: true } }))
	assert.match(report(s), /^- Sourcing: needs attention: 1\/2 listed at LCSC\/JLCPCB · 1 out of stock \(D1\)$/m)
	assert.match(report(new BringupState(tempDir())), /^- Sourcing: no bom\.json \(no parts yet\)$/m)
})
