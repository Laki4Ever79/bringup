import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import type { EnclosureArtifact } from "../src/contract/consistency.ts"
import { writeReport } from "../src/report.ts"
import { BringupState } from "../src/runtime.ts"
import type { Env } from "../src/tools/env.ts"
import { tempDir } from "./helpers.ts"

const env: Env = { root: ".", tsci: "tsci", kicad: "docker", python: "python", pio: "pio" }

function enclosure(extra: Partial<EnclosureArtifact>): EnclosureArtifact {
	return {
		revision: 4, stlPath: "/e/case.stl", stepPath: "/e/case.step", lidStlPath: "/e/lid.stl", lidStepPath: "/e/lid.step", cutouts: [],
		standoffs: [{ xMm: 3, yMm: 3, holeMm: 1.6 }, { xMm: 47, yMm: 3, holeMm: 1.6 }],
		printCheck: { ok: true, issues: [] },
		...extra,
	}
}

function report(s: BringupState, opts: { noHardware?: boolean } = {}): string {
	return readFileSync(writeReport(s.outDir, s, env, true, opts), "utf8")
}

test("report lists the print files and a passing print check", () => {
	const s = new BringupState(tempDir())
	s.artifacts.enclosure = enclosure({})
	const text = report(s)
	assert.match(text, /^- Print files: \/e\/case\.stl, \/e\/lid\.stl$/m)
	assert.match(text, /^- Print check: ok \(case open side up, lid plate down; 2 M2 standoffs for self-tapping screws\)$/m)
})

test("report lists each print-check issue", () => {
	const s = new BringupState(tempDir())
	s.artifacts.enclosure = enclosure({ printCheck: { ok: false, issues: ["wall 1 mm < 1.2 mm", "case: J9: 17.0 mm bridge at z 9.1 mm (max 12 mm without support)"] } })
	const text = report(s)
	assert.match(text, /^- Print check: 2 issue\(s\)$/m)
	assert.match(text, /^ {2}- wall 1 mm < 1\.2 mm$/m)
	assert.match(text, /^ {2}- case: J9: 17\.0 mm bridge/m)
})

test("a stubbed enclosure has no print files to list", () => {
	const s = new BringupState(tempDir())
	s.artifacts.enclosure = { ...enclosure({ printCheck: undefined, lidStlPath: undefined }), stub: true } as EnclosureArtifact
	const text = report(s, { noHardware: true })
	assert.match(text, /^- Print files: none \(--no-hardware: the enclosure was not built\)$/m)
	assert.doesNotMatch(text, /Print check/)
})
