// A build that failed for a missing tool wakes no owner (no contract change installs a tool); one that failed on the
// design does.
import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { BringupState, startRuntime } from "../src/runtime.ts"
import { inferenceConfig } from "../src/inference/models.ts"
import { mockScripts } from "../src/inference/scripts.ts"
import { createPartsAgent } from "../src/agents/roles.ts"
import { recorder, tempDir, waitFor } from "./helpers.ts"

afterEach(() => new Promise((r) => setTimeout(r, 300)))

test("a build failed for a missing tool wakes no agent; a design failure still does", async () => {
	const state = new BringupState(tempDir(), 2000)
	startRuntime(state, inferenceConfig(true, mockScripts()), null)
	const events = recorder()
	const { getOutbox } = await import("../src/runtime.ts")
	const { makeEvent } = await import("../src/events.ts")
	const parts = createPartsAgent({ mock: true }).getId()
	const fromParts = () => events.filter((e) => e.producerId === parts && !["artifact.failed", "participant.joined"].includes(e.type))
	getOutbox().emit(makeEvent("artifact.failed", parts, { kind: "board", revision: 3, error: "tscircuit build failed: tsci is not installed (tools/node)" }), parts)
	await new Promise((r) => setTimeout(r, 500))
	assert.deepEqual(fromParts().map((e) => e.type), [], "a missing tool woke the parts agent")
	getOutbox().emit(makeEvent("artifact.failed", parts, { kind: "board", revision: 4, error: "unknown footprint soic9 on U3" }), parts)
	await waitFor(() => fromParts().length > 0, 3000)
})
