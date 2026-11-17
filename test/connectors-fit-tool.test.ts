// The contract tool fits what the architect proposes (rover run cc-rover-4, 15 Nov 2026: J1 at bottom@42 mm and JM2 at
// right@10 mm overlapped across a corner of the 54x24 mm board and stayed so for revisions), and an outline change takes
// the connectors with it (cc-rover-3: the 78x16 mm shrink left J5 1 mm past the edge).
import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { FunctionCallOutputItem, ModelMessageItem } from "@mozaik-ai/core"
import { BringupState, startRuntime } from "../src/runtime.ts"
import { inferenceConfig } from "../src/inference/models.ts"
import { toolCall, type Script } from "../src/inference/scripted-runner.ts"
import { createRoleAgent, startTurn } from "../src/agents/common.ts"
import { connectorClashes, connectorsOffEdge } from "../src/contract/consistency.ts"
import { OWNERS, type ContractSnapshot, type FieldName } from "../src/contract/types.ts"
import { tempDir, waitFor } from "./helpers.ts"

afterEach(() => new Promise((r) => setTimeout(r, 200)))

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as ContractSnapshot

function seeded(s: ContractSnapshot, skip: FieldName[]) {
	const state = new BringupState(tempDir(), 3000)
	for (const [field, value] of Object.entries(s.values) as [FieldName, never][]) {
		if (skip.includes(field) || value === undefined) continue
		const r = state.contract.propose({ field, value, by: OWNERS[field], baseVersion: 0 })
		assert.equal(r.status, "applied", `${field}: ${JSON.stringify(r)}`)
	}
	return state
}

const once = (call: ReturnType<typeof toolCall>): Script => (items) => (items.at(-1) instanceof FunctionCallOutputItem ? [ModelMessageItem.rehydrate({ text: "done" })] : [call])

test("connectors the architect proposes overlapping across a corner are applied moved apart", async () => {
	const s = fixture("cc-rover-4-54x24-rev40.json")
	const state = seeded(s, ["connectors"])
	startRuntime(state, inferenceConfig(true, { "mock-architect": once(toolCall("propose_contract_change", { field: "connectors", value: s.values.connectors, baseVersion: 0, reason: "run 4's connectors" })) }), null)
	const architect = createRoleAgent({ role: "architect", instruction: "x", handlers: [], mock: true })
	startTurn(architect, "place the connectors")
	await waitFor(() => state.contract.version("connectors") === 1)
	const now = state.contract.snapshot()
	assert.deepEqual(connectorClashes(now), [])
	assert.deepEqual(connectorsOffEdge(now), [])
})

test("an outline change that leaves a connector past its edge moves it back, in the same revision", async () => {
	const s = fixture("cc-rover-3-78x16-rev25.json")
	const state = seeded({ ...s, values: { ...s.values, outline: { ...s.values.outline!, heightMm: 17 } } }, [])
	startRuntime(state, inferenceConfig(true, { "mock-architect": once(toolCall("propose_contract_change", { field: "outline", value: s.values.outline, baseVersion: 1, reason: "shrink to 78x16" })) }), null)
	const architect = createRoleAgent({ role: "architect", instruction: "x", handlers: [], mock: true })
	startTurn(architect, "shrink the board")
	await waitFor(() => state.contract.version("connectors") === 2)
	const now = state.contract.snapshot()
	assert.equal(now.values.outline!.heightMm, 16)
	// One revision for both: the seed's last, plus the outline change that carried the connectors.
	assert.equal(now.revision, Object.keys(s.values).filter((f) => (s.values as Record<string, unknown>)[f] !== undefined).length + 1)
	assert.deepEqual(connectorsOffEdge(now), [])
	// J5, a JST SH plug, by its 7.8 mm courtyard: at most 12.1 mm along the 16 mm edge.
	assert.equal(now.values.connectors!.find((k) => k.ref === "J5")!.offsetMm, 12)
})

// Real run 19b (Eurobot, 17 Nov 2026): the space check said "e.g. 48×29 mm" at rev 33, judging each size with the
// connectors at the same place along their edges, but the outline change left them where the 42×28 board had them, and
// at 48×29 U7 found no spot (revs 37-39). Now the outline change moves them as the check judged, in the same revision:
// rev 39's own minimum (52×25) then places, and builds (DRC 0, by hand 17 Nov).
test("an outline change carries its connectors at the same place along their edges, as the space check judged the size", async () => {
	const { placesAll, minimumBoard } = await import("../src/contract/space.ts")
	const s = fixture("cc-eurobot19b-rev39.json")
	const m = minimumBoard(s)!
	assert.deepEqual([m.widthMm, m.heightMm], [52, 25])
	const state = seeded(s, [])
	const rev = state.contract.revision
	startRuntime(state, inferenceConfig(true, { "mock-architect": once(toolCall("propose_contract_change", { field: "outline", value: { ...s.values.outline, widthMm: 52, heightMm: 25 }, baseVersion: 1, reason: "the space check's minimum" })) }), null)
	const architect = createRoleAgent({ role: "architect", instruction: "x", handlers: [], mock: true })
	startTurn(architect, "resize the board")
	await waitFor(() => state.contract.version("connectors") === 2)
	const now = state.contract.snapshot()
	assert.equal(now.revision, rev + 1)
	assert.equal(placesAll(now, 52, 25), true)
	// The same change with the connectors left where they were doesn't place: what the run did.
	assert.equal(placesAll({ ...now, values: { ...now.values, connectors: s.values.connectors } }, 52, 25), false)
})
