// Fixes from the first real-model system run (9 Nov 2026): links handed to an empty board, a revision cap that kept
// re-arming, a review finding that created a model, connectors crowding one edge; and the wake button's window.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ModelMessageItem, UserMessageItem, FunctionCallOutputItem, type ContextItem } from "@mozaik-ai/core"
import { connectorClashes } from "../src/contract/consistency.ts"
import { linkChecks } from "../src/contract/links.ts"
import { addedForYou } from "../src/contract/added.ts"
import { boardLinks } from "../src/system/derive.ts"
import { ROOT, runDesign } from "../src/run.ts"
import { LOGGER_DESIGN, mockScripts } from "../src/inference/scripts.ts"
import { toolCall, type Script } from "../src/inference/scripted-runner.ts"
import { state } from "../src/runtime.ts"
import type { Env } from "../src/tools/env.ts"
import type { SystemSpec } from "../src/system/spec.ts"
import { fixtureContract } from "./fixture.ts"
import { tempDir } from "./helpers.ts"

const bare: Env = { root: ROOT, tsci: null, kicad: null, python: null, pio: null }
const logger = () => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	return s
}

test("link checks wait until the board is drafted: an MCU and its pins", () => {
	const spec: SystemSpec = { name: "s", boards: [{ name: "a", brief: "a.md" }, { name: "b", brief: "b.md" }], links: [{ id: "L1", kind: "uart", a: { board: "a" }, b: { board: "b" }, cable: { lengthMm: 300 } }] }
	const empty = fixtureContract()
	empty.values = { links: boardLinks(spec, "a") }
	assert.deepEqual(linkChecks(empty), [], "nothing to fix before the brief is drafted")
	const drafted = logger()
	drafted.values.links = boardLinks(spec, "a")
	assert.ok(linkChecks(drafted).length > 0)
})

test("connectors that crowd one edge are a violation for the architect, before any build", () => {
	const s = logger()
	s.values.connectors = [...s.values.connectors!, { ref: "SW1", kind: "button", edge: "right", offsetMm: 14, widthMm: 5.8, heightMm: 3 }, { ref: "JL1", kind: "header", edge: "right", offsetMm: 7, widthMm: 5.8, heightMm: 3 }]
	const v = connectorClashes(s)
	assert.equal(v.length, 1)
	assert.match(v[0].message, /SW1 \(right@14 mm\) and JL1 \(right@7 mm\) (overlap on the board|leave 0\.2 mm of case wall)/)
	assert.deepEqual(v[0].affects, ["architect"])
	// Far apart on the same edge: fine. A bare board has no case wall to keep.
	s.values.connectors = s.values.connectors.map((k) => (k.ref === "JL1" ? { ...k, offsetMm: 5 } : k.ref === "SW1" ? { ...k, offsetMm: 20 } : k))
	assert.deepEqual(connectorClashes(s), [])
	assert.deepEqual(connectorClashes(logger()), [])
})

test("a wake button's longer window is listed for the engineer, with its cost and where to change it", () => {
	const s = logger()
	assert.ok(!addedForYou(s).some((i) => i.id === "button-window"))
	s.values.pins = [...s.values.pins!, { signal: "BUTTON", gpio: 3, partRef: "SW1", partPin: "A" }]
	const item = addedForYou(s).find((i) => i.id === "button-window")!
	assert.match(item.what, /visible for a phone for 30 s/)
	assert.match(item.cost, /0\.8–2\.6 C/)
	assert.match(item.change, /BUTTON_ADVERTISE_MS/)
})

const lastUser = (items: ContextItem[]) => (items.findLast((i) => i instanceof UserMessageItem) as UserMessageItem | undefined)?.content.text ?? ""
const steps = (items: ContextItem[]) => items.slice(items.findLastIndex((i) => i instanceof UserMessageItem)).filter((i) => i instanceof FunctionCallOutputItem).length

test("a review finding that names the model doesn't create one", { timeout: 90_000 }, async () => {
	const outDir = tempDir()
	let mlTurns = 0
	const reviewer: Script = (items) => {
		if (items.at(-1) instanceof UserMessageItem) return [toolCall("submit_review", { verdict: "fail", findings: [{ severity: "major", fields: ["rails", "model"], issue: "the battery margin", suggestion: "check the averages" }] })]
		return [ModelMessageItem.rehydrate({ text: "submitted" })]
	}
	const ml: Script = (items) => {
		if (lastUser(items).startsWith("Review findings")) mlTurns++
		return [ModelMessageItem.rehydrate({ text: "nothing" })]
	}
	await runDesign({ brief: readFileSync(join(ROOT, "briefs/logger.md"), "utf8"), mock: true, outDir, env: bare, noHardware: true, maxReviewRounds: 1, timeoutMs: 60_000, scripts: { ...mockScripts(), "mock-reviewer": reviewer, "mock-ml": ml } })
	assert.equal(mlTurns, 0, "no model in the design: the finding isn't the ML engineer's")
	assert.equal(JSON.parse(readFileSync(join(outDir, "contract.json"), "utf8")).values.model, undefined)
})

test("past the revision cap, the agents' own changes don't re-arm a run that stays up; only the engineer does", { timeout: 90_000 }, async () => {
	const outDir = tempDir()
	// An architect that, once the brief is drafted, keeps nudging the board's width in one long turn.
	const base = mockScripts()["mock-architect"]
	const churn: Script = (items) => {
		if (!lastUser(items).startsWith("Brief")) return base(items)
		if (steps(items) < 5) return base(items)
		if (steps(items) > 40) return [ModelMessageItem.rehydrate({ text: "done" })]
		const o = state().contract.get("outline")!
		return [toolCall("propose_contract_change", { field: "outline", value: { ...o, widthMm: 50 + (steps(items) % 2) }, baseVersion: state().contract.version("outline"), reason: "churn" })]
	}
	let release = () => {}
	const until = new Promise<void>((r) => (release = r))
	const done = runDesign({ brief: readFileSync(join(ROOT, "briefs/logger.md"), "utf8"), mock: true, outDir, env: bare, noHardware: true, review: false, maxRevisions: 10, stay: { until }, scripts: { ...mockScripts(), "mock-architect": churn } })
	await new Promise((r) => setTimeout(r, 8000))
	release()
	await done
	const trace = readFileSync(join(outDir, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
	const settles = trace.filter((e) => e.type === "design.settled")
	assert.equal(settles.length, 1, `settled ${settles.length} times: ${JSON.stringify(settles.map((e) => e.payload))}`)
	assert.equal(settles[0].payload.settled, false)
})
