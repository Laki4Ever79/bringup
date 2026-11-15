// The real architect of rover run 4 (15 Nov 2026) wrote the pins first, as told (I2C_SDA on JT1.IO1, the motor inputs on
// U5), before the parts agent had added JT1 and U5. The board build ran anyway and failed in tscircuit ("Could not find
// port for selector .JT1 > .IO1"), waking the owners with a confusing error. Caught on the contract now, to the parts
// owner; the board build stops at once with the reason, and that failure wakes nobody (the check already did).
import { test } from "node:test"
import assert from "node:assert/strict"
import { checkConsistency } from "../src/contract/consistency.ts"
import { buildBoard, WAITING_ON_CONTRACT } from "../src/tools/board.ts"
import { TOOL_MISSING } from "../src/agents/roles.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { fixtureContract } from "./fixture.ts"
import { tempDir } from "./helpers.ts"

const withPinToMissingPart = () => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	s.values.pins = [...s.values.pins!, { signal: "MOT_AIN1", gpio: 4, partRef: "U5", partPin: "AIN1" }]
	return s
}

test("a pin on a part that isn't in the parts list is a violation for the parts owner, naming both", () => {
	const plain = fixtureContract()
	plain.values = { ...plain.values, ...structuredClone(LOGGER_DESIGN) }
	assert.deepEqual(checkConsistency(plain, {}).filter((v) => v.kind === "pin-part-missing"), [])
	const v = checkConsistency(withPinToMissingPart(), {}).filter((x) => x.kind === "pin-part-missing")
	assert.equal(v.length, 1)
	assert.match(v[0].message, /MOT_AIN1 goes to U5\.AIN1, but there is no part U5/)
	assert.deepEqual(v[0].affects, ["parts"])
})

test("the board build stops at once with the reason, and that failure wakes no owner", async () => {
	const env = { root: "/nonexistent", tsci: "/nonexistent/tsci", kicad: null } as never
	const t0 = Date.now()
	await assert.rejects(buildBoard(env, tempDir(), withPinToMissingPart(), 1), (e: Error) => WAITING_ON_CONTRACT.test(e.message) && /U5/.test(e.message))
	assert.ok(Date.now() - t0 < 2000, "it ran tscircuit")
	assert.doesNotMatch("tscircuit build failed (exit 1)", WAITING_ON_CONTRACT)
	assert.ok(TOOL_MISSING instanceof RegExp)
})

// Real rover run 10 (15 Nov 2026), revisions 14 and 15: the architect had written the pins, but the parts agent hadn't
// added the MCU yet (it came back at revision 25). The board build failed in circuitFromContract ("pin assignments need
// a part with role mcu"), twice, waking owners for a contract that was only incomplete.
const withoutMcu = () => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	s.values.parts = s.values.parts!.filter((p) => p.role !== "mcu")
	return s
}

test("pins with no MCU in the parts list are a violation for the parts owner", () => {
	const v = checkConsistency(withoutMcu(), {}).filter((x) => x.kind === "pin-part-missing")
	assert.equal(v.length, 1, JSON.stringify(v))
	assert.match(v[0].message, /no MCU/)
	assert.deepEqual(v[0].affects, ["parts"])
})

test("the board build waits for the MCU instead of failing", async () => {
	const env = { root: "/nonexistent", tsci: "/nonexistent/tsci", kicad: null } as never
	await assert.rejects(buildBoard(env, tempDir(), withoutMcu(), 1), (e: Error) => WAITING_ON_CONTRACT.test(e.message) && /MCU/.test(e.message))
})
