// A CNC's power tree (the brick's 5 V step-down and the OR-ing Schottkys, src/contract/power-auto.ts) lands whichever
// comes first, the parts or the fields that make the design a CNC. CNC mock 14 (27 Nov 2026): the parts came at revision
// 2, the rails at 5 and cncTargets at 7; the tree ran only on a parts write with cncTargets already there, so it never
// ran, no V5 net existed and the spindle buffer's VCC was on no net (supply-unwired).
import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { FunctionCallOutputItem, ModelMessageItem } from "@mozaik-ai/core"
import { BringupState, startRuntime } from "../src/runtime.ts"
import { inferenceConfig } from "../src/inference/models.ts"
import { toolCall, type Script } from "../src/inference/scripted-runner.ts"
import { createRoleAgent, startTurn } from "../src/agents/common.ts"
import { OWNERS, type ContractSnapshot, type FieldName } from "../src/contract/types.ts"
import { CNC_DESIGN, CNC_TARGETS } from "../src/inference/scripts.ts"
import { fixtureContract } from "./fixture.ts"
import { tempDir, waitFor } from "./helpers.ts"

afterEach(() => new Promise((r) => setTimeout(r, 200)))

const POWER = ["buck", "diode", "ideal-diode"]
const tree = (s: ContractSnapshot) => (s.values.parts ?? []).filter((p) => POWER.includes(p.role ?? "")).map((p) => p.role).sort()
const once = (call: ReturnType<typeof toolCall>): Script => (items) => (items.at(-1) instanceof FunctionCallOutputItem ? [ModelMessageItem.rehydrate({ text: "done" })] : [call])

test("parts and rails first, cncTargets later: the targets' write lands the brick's power tree (one parts write)", async () => {
	const b = fixtureContract()
	const state = new BringupState(tempDir(), 3000)
	for (const [field, value] of Object.entries({ ...b.values, ...CNC_DESIGN }) as [FieldName, never][]) {
		if (value === undefined || field === "cncTargets" || field === "cnc") continue
		assert.equal(state.contract.propose({ field, value, by: OWNERS[field], baseVersion: 0 }).status, "applied", field)
	}
	assert.deepEqual(tree(state.contract.snapshot()), [], "no tree before the design is a CNC")
	const partsBefore = state.contract.version("parts")
	startRuntime(state, inferenceConfig(true, { "mock-architect": once(toolCall("propose_contract_change", { field: "cncTargets", value: CNC_TARGETS, baseVersion: 0, reason: "the brief's machine" })) }), null)
	const architect = createRoleAgent({ role: "architect", instruction: "x", handlers: [], mock: true })
	startTurn(architect, "write the CNC's targets")
	await waitFor(() => state.contract.version("cncTargets") === 1)
	await waitFor(() => state.contract.version("parts") === partsBefore + 1)
	assert.deepEqual(tree(state.contract.snapshot()), ["buck", "diode", "diode"])
})
