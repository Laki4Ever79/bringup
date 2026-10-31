import assert from "node:assert/strict"
import { test } from "node:test"
import { rippleMarks } from "../src/dashboard/model.js"
import { ventOutline } from "../src/dashboard/scene3d.js"

// The show-off moment of a ripple: what is new or changed glows on the PCB, and new case features pulse in 3D.
const part = (ref: string, mpn: string, role = "x") => ({ ref, mpn, role, footprint: "f" })
const pin = (signal: string, gpio: number, partRef: string) => ({ signal, gpio, partRef, partPin: "p" })

test("rippleMarks: an added sensor is new; parts it wired into changed; nothing marked without a before", () => {
	const before = { parts: [part("U1", "ESP32-C3-MINI-1", "mcu"), part("D1", "LED")], pins: [pin("STATUS_LED", 10, "D1")] }
	const after = { parts: [...before.parts, part("U2", "SHT40-AD1B-R2", "sensor")], pins: [...before.pins, pin("I2C_SDA", 8, "U2"), pin("I2C_SCL", 9, "U2")] }
	assert.deepEqual(rippleMarks(before, after), { added: ["U2"], changed: ["U1"] })
	// A swap keeps the ref: changed, not new.
	const swapped = { ...after, parts: after.parts.map((p) => (p.ref === "U2" ? part("U2", "SHTC3", "sensor") : p)) }
	assert.deepEqual(rippleMarks(after, swapped), { added: [], changed: ["U2"] })
	assert.deepEqual(rippleMarks(null, after), { added: [], changed: [] })
})

test("ventOutline: af's grille (board frame, centre + box) becomes a box and 4 slots on the lid's top, in scene space", () => {
	const v = ventOutline({ ref: "U2", xMm: 45.5, yMm: 7, widthMm: 8.4, heightMm: 6, openMm2: 28.8 }, [-25, -15], 16)
	// Board frame (origin bottom-left) → scene: + the board's min corner (already offset into the case).
	assert.deepEqual(v.box, [[16.3, -11, 16], [24.7, -11, 16], [24.7, -5, 16], [16.3, -5, 16]])
	assert.equal(v.slots.length, 4)
	// 1.2 mm slots at a 2.4 mm pitch, centred on the grille, running along Y.
	assert.deepEqual(v.slots.map((s) => s[0][0]), [16.9, 19.3, 21.7, 24.1])
	for (const s of v.slots) assert.deepEqual([s[0][1], s[1][1]], [-11, -5])
})
