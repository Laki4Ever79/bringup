// A chip without a radio (docs/mcu.md): no Bluetooth default, and a connectivity field asking for one is a violation.
import { test } from "node:test"
import assert from "node:assert/strict"
import { complianceItems } from "../src/contract/compliance.ts"
import { connectivityChecks, connectivityOf, connectivityShapeError } from "../src/contract/connectivity.ts"
import { chipPartPins } from "../src/mcu/board.ts"
import { profileById } from "../src/mcu/profile.ts"
import { fixtureContract } from "./fixture.ts"

function stm() {
	const s = fixtureContract()
	s.values.parts = s.values.parts!.map((p) => (p.role === "mcu" ? { ...p, mpn: "STM32G031K8T6", lcsc: "C432203", footprint: "", pins: chipPartPins(profileById("stm32g031k8t6")!) } : p))
	return s
}

test("an STM32G031 design without a connectivity field has no radio; an ESP32-C3 one keeps BLE", () => {
	assert.deepEqual(connectivityOf(stm()), { radio: "none", report: [], updates: "none" })
	assert.equal(connectivityOf(fixtureContract()).radio, "ble")
})

test("asking a chip without a radio for BLE is a violation for the parts and firmware", () => {
	const s = stm()
	s.values.connectivity = { radio: "ble", report: ["gatt"], updates: "none" }
	const v = connectivityChecks(s)
	assert.equal(v[0]?.kind, "radio-missing")
	assert.match(v[0].message, /the STM32G031K8T6 has no radio/)
	assert.deepEqual(v[0].affects, ["parts", "firmware"])
})

test('radio "none" is a valid shape only with nothing reported and no updates', () => {
	assert.equal(connectivityShapeError({ radio: "none", report: [], updates: "none" }), null)
	assert.match(connectivityShapeError({ radio: "none", report: ["gatt"], updates: "none" }) ?? "", /reports nothing/)
})

test("no radio, no radio rules: only EMC is left to check", () => {
	const items = complianceItems(stm())
	assert.equal(items.length, 1)
	assert.match(items[0].item, /unintentional radiator/)
})
