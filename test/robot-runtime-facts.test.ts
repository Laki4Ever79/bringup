// Rover runs cc-rover-8 and -9 (16 Nov 2026, Claude subscription) both passed review with the note "no duty cycle, so
// the power budget shows unknown": a robot's battery is sized by its runtime while driving, which the mechanics check
// already computes. The power budget says that figure instead.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { designFacts } from "../src/agents/design-facts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

test("a robot's power budget states its driving runtime from the mechanics check, not 'unknown'", () => {
	const s = JSON.parse(readFileSync(new URL("./fixtures/cc-rover-9-rev24.json", import.meta.url), "utf8")) as ContractSnapshot
	const line = designFacts(s, readFileSync("briefs/rover.md", "utf8")).find((l) => l.startsWith("- Estimated battery life"))
	assert.ok(line, "a battery-life line")
	assert.match(line, /a robot: its runtime while driving/)
	assert.match(line, /\d+ min against at least 30 min \(met/)
	assert.doesNotMatch(line, /unknown/)
})
