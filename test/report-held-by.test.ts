// The mock rover (17 Nov 2026) ended "UNSETTLED at revision 15 with 0 violation(s)": two grounding findings held it, and
// nothing in the report said so. An unsettled report now names everything that held it besides the violations.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { heldBy, writeReport } from "../src/report.ts"
import { BringupState } from "../src/runtime.ts"
import type { Env } from "../src/tools/env.ts"
import { tempDir } from "./helpers.ts"

const env = { tsci: null, kicad: null, pio: null } as unknown as Env

test("an unsettled report names the grounding findings and failed builds that held it", () => {
	const s = new BringupState(tempDir())
	s.groundingFindings = [{ partRef: "JM1", kind: "pin-not-on-part", detail: "JM1 lists pin 1, which catalog X does not have", source: "catalog" }]
	s.artifactFailures.firmware = "pio run failed\nline 2"
	const held = heldBy(s)
	assert.ok(held.includes("grounding: JM1 pin-not-on-part: JM1 lists pin 1, which catalog X does not have"), held.join("\n"))
	assert.ok(held.includes("firmware build failed: pio run failed"), held.join("\n"))
	const report = readFileSync(writeReport(s.outDir, s, env, false, { noHardware: true }), "utf8")
	assert.match(report, new RegExp(`Held by \\(besides the violations\\): ${held.length}\\n- grounding: JM1 pin-not-on-part`))
	// Settled: no such line.
	assert.doesNotMatch(readFileSync(writeReport(s.outDir, s, env, true, { noHardware: true }), "utf8"), /Held by/)
})
