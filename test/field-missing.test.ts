// An agent that stops with a field unwritten is asked once before the run gives up (real run 7, 9 Nov 2026: the
// architect's pins were refused once, it moved on, nothing asked again, and the run ended stuck with no pins).
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { FunctionCallOutputItem, ModelMessageItem, UserMessageItem, type ContextItem } from "@mozaik-ai/core"
import { ROOT, runDesign } from "../src/run.ts"
import { LOGGER_DESIGN, mockScripts } from "../src/inference/scripts.ts"
import { toolCall, type Script } from "../src/inference/scripted-runner.ts"
import { state } from "../src/runtime.ts"
import type { Env } from "../src/tools/env.ts"
import { tempDir } from "./helpers.ts"

const bare: Env = { root: ROOT, tsci: null, kicad: null, python: null, pio: null }
const lastUser = (items: ContextItem[]) => (items.findLast((i) => i instanceof UserMessageItem) as UserMessageItem | undefined)?.content.text ?? ""
// Tool results since the turn's message: how many steps this turn has taken.
const steps = (items: ContextItem[]) => items.slice(items.findLastIndex((i) => i instanceof UserMessageItem)).filter((i) => i instanceof FunctionCallOutputItem).length

// The scripted architect, but it stops before the pins (its fifth field), and writes them only when asked.
function architectThatForgetsPins(answerAsk: boolean): Script {
	const base = mockScripts()["mock-architect"]
	return (items) => {
		const text = lastUser(items)
		if (text.startsWith("Brief") && steps(items) >= 4) return [ModelMessageItem.rehydrate({ text: "done, except the pins" })]
		if (text.includes("field-missing")) {
			if (!answerAsk || steps(items) > 0) return [ModelMessageItem.rehydrate({ text: "ok" })]
			return [toolCall("propose_contract_change", { field: "pins", value: LOGGER_DESIGN.pins, baseVersion: state().contract.version("pins"), reason: "the pins, asked for" })]
		}
		return base(items)
	}
}

const run = async (answerAsk: boolean) => {
	const outDir = tempDir()
	const brief = readFileSync(join(ROOT, "briefs/logger.md"), "utf8")
	const result = await runDesign({ brief, mock: true, outDir, env: bare, noHardware: true, review: false, timeoutMs: 60_000, scripts: { ...mockScripts(), "mock-architect": architectThatForgetsPins(answerAsk) } })
	const trace = readFileSync(join(outDir, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
	return { result, trace }
}

test("a field nobody wrote is asked of its owner once, and the run settles when it is written", { timeout: 90_000 }, async () => {
	const { result, trace } = await run(true)
	const asks = trace.filter((e) => e.type === "consistency.checked" && e.payload.violations.some((v: { kind: string }) => v.kind === "field-missing"))
	assert.equal(asks.length, 1)
	assert.deepEqual(asks[0].payload.violations.find((v: { kind: string }) => v.kind === "field-missing").affects, ["architect"])
	assert.equal(result.settled, true)
})

test("an owner that still doesn't write it ends the run unsettled, as before", { timeout: 90_000 }, async () => {
	const { result } = await run(false)
	assert.equal(result.settled, false)
})
