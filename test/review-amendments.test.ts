import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { REVIEW_INSTRUCTION, reviewMessage } from "../src/agents/reviewer.ts"
import { appendRequest } from "../src/runner/requests.ts"
import { BringupState, startRuntime } from "../src/runtime.ts"
import { tempDir } from "./helpers.ts"

// af's real-model add-sensor run (docs/runs/add-sensor-real): the change rippled, then the brief review judged against
// the original brief ("Sensors … out of scope, for now") and the agents removed the sensor the engineer had asked for.
test("the engineer's change requests reach the reviewer as amendments that override the brief, newest last", async () => {
	const state = new BringupState(tempDir())
	startRuntime(state, undefined, null)
	writeFileSync(join(state.outDir, "brief.md"), "# Brief: beacon\n\n## Out of scope\n- Sensors (temperature, humidity), for now.\n")
	appendRequest(state.outDir, "add a temperature/humidity sensor")
	appendRequest(state.outDir, "edited pins.h: I2C_SDA GPIO8 → GPIO4", { kind: "file", path: "firmware/pins.h", revision: 9, items: ["I2C_SDA GPIO8 → GPIO4"] })
	const message = await reviewMessage(undefined, 0, 1)
	const brief = message.indexOf("## Product brief")
	const amendments = message.indexOf("## Engineer changes since the brief (these override it)")
	assert.ok(brief >= 0 && amendments > brief, "the amendments come right after the brief")
	assert.ok(amendments < message.indexOf("## Design contract"))
	assert.match(message, /^- req-1: add a temperature\/humidity sensor$/m)
	assert.match(message, /^- req-2: edited pins\.h: I2C_SDA GPIO8 → GPIO4 \(a file edit: firmware\/pins\.h\)$/m)
	assert.match(REVIEW_INSTRUCTION, /design that follows an engineer change is not a brief violation/)
})

test("without change requests there is no amendments section", async () => {
	const state = new BringupState(tempDir())
	startRuntime(state, undefined, null)
	writeFileSync(join(state.outDir, "brief.md"), "# Brief\n")
	assert.doesNotMatch(await reviewMessage(undefined, 0, 1), /Engineer changes since the brief/)
})
