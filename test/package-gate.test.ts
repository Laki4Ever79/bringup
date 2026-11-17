// `bringup package` refuses, by name, to package an unfinished run unless --force (src/package/gate.ts, 17 Nov 2026):
// of the 27 real runs in out/real-runs, 2 pass (rovers 8 and 9); the rest are refused for an unsettled end, open
// violations, a stale board, or a failed or missing review verdict.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { packageGate } from "../src/package/gate.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { tempDir } from "./helpers.ts"

const rover = (revision = 15): ContractSnapshot => ({ revision, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) })
const run = (report: string) => {
	const dir = tempDir()
	writeFileSync(join(dir, "report.md"), report)
	writeFileSync(join(dir, "contract.json"), "{}")
	return join(dir, "contract.json")
}
const FINISHED = "# Bringup report\n\nStatus: settled at contract revision 15\nViolations: 0\n\n## Brief review\n\nVerdict: pass after 1 review (at most 1 fix round).\n"

test("a settled run with a passing review and no findings is packaged", () => {
	assert.deepEqual(packageGate(run(FINISHED), rover()), [])
})

test("an unfinished run is refused, each reason named", () => {
	const r = (report: string, s = rover()) => packageGate(run(report), s).join("\n")
	assert.match(r(FINISHED.replace("settled at", "UNSETTLED at")), /the run ended UNSETTLED, not settled/)
	assert.match(r(FINISHED.replace("Violations: 0\n", "Violations: 2\n- net-missing: a\n- mech-fit: b\n")), /2 open violations in the report: net-missing, mech-fit/)
	assert.match(r(FINISHED.replace("Violations: 0", "Board: built at revision 11; the contract changed it after that\nViolations: 0")), /the board is stale: built at revision 11/)
	assert.match(r(FINISHED.replace("Violations: 0", "Violations: 0\nHeld by (besides the violations): 2\n- grounding: x")), /held by 2 more/)
	assert.match(r(FINISHED.replace("Verdict: pass", "Verdict: fail")), /the brief review's verdict is fail/)
	assert.match(r(FINISHED.replace(/Verdict: .*\n/, "No verdict: the reviewer ended its turn without submitting a review, so it settled.\n")), /no review verdict: the reviewer ended its turn/)
	assert.match(r(FINISHED.replace(/## Brief review\n\nVerdict: .*\n/, "Brief review: skipped (--no-review).\n")), /the brief review was skipped/)
	assert.match(r(FINISHED.replace("Verdict: pass", "Verdict: pass (scripted reviewer, not a model verdict)")), /a mock run's scripted one/)
	assert.match(r(FINISHED, rover(11)), /this contract is revision 11, but the report judged revision 15/)
})

test("a contract with no run report, or one from contracts/ that isn't the final, is refused", () => {
	const bare = join(tempDir(), "design.json")
	assert.match(packageGate(bare, rover()).join("\n"), /no run report beside/)
	const dir = tempDir()
	writeFileSync(join(dir, "report.md"), FINISHED)
	mkdirSync(join(dir, "contracts"))
	assert.match(packageGate(join(dir, "contracts", "rev-9.json"), rover(9)).join("\n"), /this contract is revision 9, but the report judged revision 15/)
	assert.deepEqual(packageGate(join(dir, "contracts", "rev-15.json"), rover(15)), [])
})
