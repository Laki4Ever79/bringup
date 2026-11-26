import { test } from "node:test"
import assert from "node:assert/strict"
import { chipSupport, divider, nearestResistor, resolveEnd, type ChipEntry } from "../src/codegen/chip-support.ts"

const chip = { ref: "U5", pins: ["VIN", "SW", "FB", "BOOT", "RT", "AD0", "UART", "OA1", "OA2", "NC"] }
const cap = { kind: "capacitor" as const, value: "100nF", lcsc: "C1525", mpn: "CL05B104KO5NNNC", footprint: "0402" }
const plug = { kind: "connector" as const, value: "JST-XH-4", lcsc: "C144395", mpn: "B4B-XH-A", footprint: "jst4_xh" }

test("every end kind resolves: GND, $in, $out, $:local, @shared, rail:, $ctx:, -, and own pins", () => {
	const ctx = { in: "VIN_BRICK", out: "VSERVO1", outV: 6, ad0: "rail:3V3" }
	assert.deepEqual(resolveEnd("GND", chip, ctx), { net: "GND" })
	assert.deepEqual(resolveEnd("$in", chip, ctx), { net: "VIN_BRICK" })
	assert.deepEqual(resolveEnd("$out", chip, ctx), { net: "VSERVO1" })
	assert.deepEqual(resolveEnd("$:SW", chip, ctx), { net: "U5_SW" })
	assert.deepEqual(resolveEnd("@STEPPER_UART", chip, ctx), { net: "STEPPER_UART" })
	assert.deepEqual(resolveEnd("rail:3V3", chip, ctx), { net: "V3V3" })
	assert.deepEqual(resolveEnd("$ctx:ad0", chip, ctx), { net: "V3V3" })
	assert.equal(resolveEnd("-", chip, ctx), null)
	assert.deepEqual(resolveEnd("BOOT", chip, ctx), { ref: "U5", pin: "BOOT" })
	assert.throws(() => resolveEnd("NOPE", chip, ctx), /no end and no pin of U5/)
})

test("an entry's nets join the chip's pins; its supports become parts, two-pin, counted, multi-pin and computed", () => {
	const entry: ChipEntry = {
		mpn: "TEST", pins: chip.pins,
		nets: { VIN: "$in", SW: "$:SW", AD0: "$ctx:ad0", UART: "@STEPPER_UART", NC: "-" },
		support: [
			{ part: cap, a: "BOOT", b: "$:SW", job: "bootstrap", bound: 5 },
			{ part: "bulk", a: "$in", b: "GND", count: 2, job: "input capacitor" },
			{ part: { compute: "divider", vref: 0.8, from: "$out", to: "FB" }, job: "feedback divider" },
			{ part: { compute: "resistor", ohms: 200000 }, a: "RT", b: "GND", job: "RT (500 kHz)" },
			{ part: plug, pins: { "1": "OA1", "2": "OA2", "3": "GND", "4": "-" }, job: "motor plug" },
		],
	}
	const { jobs, joins } = chipSupport(chip, entry, { in: "VIN_BRICK", out: "VSERVO1", outV: 6, ad0: "GND" }, { bulk: cap })
	assert.deepEqual(joins, [
		{ net: "VIN_BRICK", ref: "U5", pin: "VIN" },
		{ net: "U5_SW", ref: "U5", pin: "SW" },
		{ net: "GND", ref: "U5", pin: "AD0" },
		{ net: "STEPPER_UART", ref: "U5", pin: "UART" },
	])
	assert.deepEqual(jobs.map((j) => j.job), ["U5 bootstrap", "U5 input capacitor 1 of 2", "U5 input capacitor 2 of 2", "U5 feedback divider: top (5.976 V from 0.8 V)", "U5 feedback divider: bottom", "U5 RT (500 kHz)", "U5 motor plug"])
	assert.deepEqual([jobs[0].a, jobs[0].b, jobs[0].bound], [{ ref: "U5", pin: "BOOT" }, { net: "U5_SW" }, 5])
	assert.deepEqual([jobs[3].a, jobs[3].b, jobs[4].a, jobs[4].b], [{ net: "VSERVO1" }, { ref: "U5", pin: "FB" }, { ref: "U5", pin: "FB" }, { net: "GND" }])
	assert.equal(jobs[5].spec.value, "200k")
	assert.deepEqual(jobs[6].pins, { "1": { ref: "U5", pin: "OA1" }, "2": { ref: "U5", pin: "OA2" }, "3": { net: "GND" } })
})

test("computed values come from JLCPCB's basic resistors: a 6 V divider at 0.8 V is 33k/5.1k (5.98 V); RT 200k", () => {
	const d = divider(0.8, 6)
	assert.deepEqual([d.top.value, d.top.lcsc, d.bottom.value, d.bottom.lcsc, d.outV], ["33k", "C25779", "5.1k", "C25905", 5.976])
	assert.equal(nearestResistor(200000).lcsc, "C25764")
	assert.equal(nearestResistor(16900).value, "15k")
})
