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

// A robot with a pull-cord start (match.h): the facts say how it starts and when it stops, from the generated header.
test("a robot with a start cord's facts say it waits for the cord and stops after the match; one without keeps today's", () => {
	const s = JSON.parse(readFileSync(new URL("./fixtures/cc-rover-7-rev34.json", import.meta.url), "utf8")) as ContractSnapshot
	const without = firmwareFacts(s).join("\n")
	assert.doesNotMatch(without, /start cord|pull cord/)
	const v = s.values as ContractSnapshot["values"] & Record<string, never>
	const used = new Set((v.pins ?? []).map((p) => p.gpio))
	const gpio = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].find((g) => !used.has(g))!
	v.parts = [...(v.parts ?? []), { ref: "JS1", role: "start", mpn: "PZ254V-11-02P", lcsc: "C492401", footprint: "pinrow2", pins: ["START", "GND"] }]
	v.pins = [...(v.pins ?? []), { signal: "START", gpio, partRef: "JS1", partPin: "START" }]
	v.mechanics = { ...v.mechanics!, safety: { start: { connector: "JS1", cordMm: 600, matchS: 100 } } }
	const facts = firmwareFacts(s).join("\n")
	assert.match(facts, new RegExp(`START on GPIO${gpio} reads low`))
	assert.match(facts, /stayed out 50 ms/)
	assert.match(facts, /100 s after the start it stops both drive motors for good/)
	// The facts before the start fact are today's, unchanged.
	assert.ok(facts.startsWith(without))
})
