// Rover run cc-rover-7 (16 Nov 2026, Claude subscription): the reviewer was told the rover's firmware was the logger's
// (read the sensor, deep-sleep 300 s) and failed the first design that reached it with 0 open problems. A robot's
// product firmware is templates/fw-rover; the facts say what it does, from the header its build writes.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { firmwareFacts } from "../src/agents/design-facts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

test("a robot's firmware facts describe the rover firmware it ships, not the logger's", () => {
	const s = JSON.parse(readFileSync(new URL("./fixtures/cc-rover-7-rev34.json", import.meta.url), "utf8")) as ContractSnapshot
	const facts = firmwareFacts(s).join("\n")
	assert.match(facts, /templates\/fw-rover/)
	assert.match(facts, /never sleeps/)
	assert.match(facts, /DRV8833/)
	assert.match(facts, /VL53L0X/)
	assert.match(facts, /turns in place for \d+ ms/)
	assert.match(facts, /BTHome/)
	assert.doesNotMatch(facts, /deep-sleeps/)
})
