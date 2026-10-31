import { test } from "node:test"
import assert from "node:assert/strict"
import { DesignContract } from "../src/contract/contract.ts"

const outline = { widthMm: 50, heightMm: 30, thicknessMm: 1.6 }

test("owner write applies", () => {
	const c = new DesignContract()
	const r = c.propose({ field: "outline", value: outline, by: "architect", baseVersion: 0 })
	assert.deepEqual(r, { status: "applied", version: 1, revision: 1 })
	assert.equal(c.get("outline")?.widthMm, 50)
})

test("stale base is refused", () => {
	const c = new DesignContract()
	c.propose({ field: "outline", value: outline, by: "architect", baseVersion: 0 })
	const r = c.propose({ field: "outline", value: { ...outline, widthMm: 60 }, by: "architect", baseVersion: 0 })
	assert.deepEqual(r, { status: "stale", current: 1 })
	assert.equal(c.get("outline")?.widthMm, 50)
})

test("non-owner refused without approval", () => {
	const c = new DesignContract()
	const r = c.propose({ field: "pins", value: [], by: "firmware", baseVersion: 0 })
	assert.deepEqual(r, { status: "not-owner", owner: "architect" })
})

test("non-owner applies with owner approval", () => {
	const c = new DesignContract()
	const r = c.propose({ field: "pins", value: [], by: "firmware", baseVersion: 0, approvedBy: "architect" })
	assert.equal(r.status, "applied")
})

test("snapshot is a copy", () => {
	const c = new DesignContract()
	c.propose({ field: "outline", value: outline, by: "architect", baseVersion: 0 })
	const s = c.snapshot()
	s.values.outline!.widthMm = 99
	assert.equal(c.get("outline")?.widthMm, 50)
})

test("pin signals must be UPPER_SNAKE", () => {
	const c = new DesignContract()
	const r = c.propose({ field: "pins", value: [{ signal: "status-led", gpio: 10, partRef: "D1", partPin: "A" }], by: "architect", baseVersion: 0 })
	assert.equal(r.status, "invalid")
	assert.equal(c.version("pins"), 0)
})

test("an identical value is reported unchanged and not applied", () => {
	const c = new DesignContract()
	c.propose({ field: "outline", value: outline, by: "architect", baseVersion: 0 })
	const r = c.propose({ field: "outline", value: { ...outline }, by: "architect", baseVersion: 1 })
	assert.deepEqual(r, { status: "unchanged", version: 1 })
	assert.equal(c.revision, 1)
})

test("malformed field values are refused", () => {
	const c = new DesignContract()
	assert.equal(c.propose({ field: "rails", value: { name: "3V3" } as never, by: "architect", baseVersion: 0 }).status, "invalid")
	assert.equal(c.propose({ field: "parts", value: "U1 ESP32" as never, by: "parts", baseVersion: 0 }).status, "invalid")
	assert.equal(c.propose({ field: "outline", value: { widthMm: "50" } as never, by: "architect", baseVersion: 0 }).status, "invalid")
	assert.equal(c.propose({ field: "pins", value: [{ signal: "LED", gpio: "x" }] as never, by: "architect", baseVersion: 0 }).status, "invalid")
	assert.equal(c.revision, 0)
})

test("part roles must come from the known list", () => {
	const c = new DesignContract()
	const part = { ref: "U1", role: "Microcontroller", mpn: "ESP32-C3-MINI-1", lcsc: null, footprint: "", pins: [] }
	const r = c.propose({ field: "parts", value: [part], by: "parts", baseVersion: 0 })
	assert.equal(r.status, "invalid")
	assert.match((r as { reason: string }).reason, /mcu/)
	assert.equal(c.propose({ field: "parts", value: [{ ...part, role: "mcu" }], by: "parts", baseVersion: 0 }).status, "applied")
})

test("a pin assignment must point at the peripheral, not the MCU itself", () => {
	const c = new DesignContract()
	c.propose({ field: "parts", value: [{ ref: "U1", role: "mcu", mpn: "ESP32-C3-MINI-1", lcsc: null, footprint: "", pins: ["GPIO6"] }], by: "parts", baseVersion: 0 })
	const r = c.propose({ field: "pins", value: [{ signal: "USB_D_PLUS", gpio: 6, partRef: "U1", partPin: "GPIO6" }], by: "architect", baseVersion: 0 })
	assert.equal(r.status, "invalid")
	assert.match((r as { reason: string }).reason, /USB_D_PLUS.*U1/)
})

test("with a catalog, parts must be catalog parts and the error lists the options", () => {
	const c = new DesignContract()
	c.setCatalog([{ role: "charger", mpn: "TP4054-42-SOT25R", lcsc: "C32574" }, { role: "mcu", mpn: "ESP32-C3-MINI-1", lcsc: "C2838502" }])
	const charger = { ref: "U4", role: "charger", mpn: "MCP73831T-2ACI/OT", lcsc: null, footprint: "", pins: [] }
	const r = c.propose({ field: "parts", value: [charger], by: "parts", baseVersion: 0 })
	assert.equal(r.status, "invalid")
	assert.match((r as { reason: string }).reason, /MCP73831T-2ACI\/OT.*TP4054-42-SOT25R \(C32574\)/s)
	assert.equal(c.propose({ field: "parts", value: [{ ...charger, mpn: "tp4054-42-sot25r" }], by: "parts", baseVersion: 0 }).status, "applied")
})

test("the contract keeps every revision's snapshot", () => {
	const c = new DesignContract()
	c.propose({ field: "outline", value: outline, by: "architect", baseVersion: 0 })
	c.propose({ field: "outline", value: { ...outline, widthMm: 60 }, by: "architect", baseVersion: 1 })
	assert.equal(c.snapshotAt(1)?.values.outline?.widthMm, 50)
	assert.equal(c.snapshotAt(2)?.values.outline?.widthMm, 60)
	assert.equal(c.snapshotAt(3), undefined)
	c.snapshotAt(1)!.values.outline!.widthMm = 1
	assert.equal(c.snapshotAt(1)?.values.outline?.widthMm, 50, "a copy")
})

test("validate covers every rule propose enforces, so change control can check before holding", () => {
	const c = new DesignContract()
	c.setCatalog([{ role: "mcu", mpn: "ESP32-C3-MINI-1", lcsc: "C2838502", footprint: "x", pins: [] }] as never)
	assert.equal(c.propose({ field: "parts", value: [{ ref: "U1", role: "mcu", mpn: "ESP32-C3-MINI-1", lcsc: "C2838502", footprint: "x", pins: [] }], by: "parts", baseVersion: 0 }).status, "applied")
	assert.match(c.validate({ field: "pins", value: [{ signal: "X", gpio: 1, partRef: "U1", partPin: "GPIO1" }], by: "architect" }) ?? "", /partRef must be/)
	assert.match(c.validate({ field: "pins", value: [{ signal: "led", gpio: 1, partRef: "D1", partPin: "A" }], by: "architect" }) ?? "", /signal names must match/)
	assert.match(c.validate({ field: "parts", value: [{ ref: "U9", role: "mcu", mpn: "NRF52840", lcsc: null, footprint: "x", pins: [] }], by: "parts" }) ?? "", /only catalog parts/)
})

test("a wrong behavior shape is refused with the exact shape and an example, and extra keys are refused too", () => {
	const c = new DesignContract()
	const reason = c.validate({ field: "behavior", value: { blinkOnRead: true } as never, by: "firmware" }) ?? ""
	assert.match(reason, /exactly \{blinkMs, tiltBlinkMs, tiltDeg\}/)
	assert.match(reason, /e\.g\. \{"blinkMs":1000,"tiltBlinkMs":200,"tiltDeg":20\}/)
	assert.match(c.validate({ field: "behavior", value: { blinkMs: 1000, tiltBlinkMs: 200, tiltDeg: 20, chargeLed: true } as never, by: "firmware" }) ?? "", /chargeLed/)
	assert.equal(c.validate({ field: "behavior", value: { blinkMs: 1000, tiltBlinkMs: 200, tiltDeg: 20 }, by: "firmware" }), null)
})
