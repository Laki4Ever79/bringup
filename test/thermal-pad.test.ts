// A thermal pad the pin list doesn't name (TMC2209 pin 29, DRV8833 pin 17: GND by their datasheets) gets a label, so
// tscircuit makes it a port, and on a 4-layer board a trace to GND. Without it the CNC's four TMC2209s had netless
// exposed pads, their fine-pitch GND pins had nothing to join, and rev 9 didn't route (25 unrouted); with it, 0.
import { test } from "node:test"
import assert from "node:assert/strict"
import { thermalPadPin } from "../src/codegen/circuit.ts"

test("the thermal pad's number follows the leads, only when the pins don't name it", () => {
	assert.equal(thermalPadPin("qfn28_w5.8mm_h5.8mm_p0.5mm_pl0.75mm_pw0.25mm_thermalpad3.7mmx3.7mm", 28), 29)
	assert.equal(thermalPadPin("tssop16_w6.4mm_p0.65mm_thermalpad2.31mmx2.46mm", 16), 17)
	assert.equal(thermalPadPin("qfn28_w5.8mm_h5.8mm_p0.5mm_pl0.75mm_pw0.25mm_thermalpad3.7mmx3.7mm", 29), null, "a pin names it")
	assert.equal(thermalPadPin("soic8_w5.3mm_p1.27mm", 8), null, "no thermal pad")
})
