// The board manifest (engineer, 13 Nov 2026, "do B"): every design writes bench.json, what a person or a bench tool
// needs to bring the board up without asking: the target and how to flash it, each rail's expected voltage and current,
// each pad's net and place, each signal's pin, the I2C addresses that should answer, and the bring-up steps in order.
import { test } from "node:test"
import assert from "node:assert/strict"
import { benchManifest, bringupMarkdown } from "../src/contract/manifest.ts"
import { bringupPads, recoveryPads } from "../src/codegen/circuit.ts"
import { LOGGER_DESIGN, STM32_LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { fixtureContract } from "./fixture.ts"

const design = (d: typeof LOGGER_DESIGN) => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(d) }
	return s
}

test("the manifest names the target, how it is flashed, and where its console is", () => {
	const m = benchManifest(design(LOGGER_DESIGN))!
	assert.equal(m.schema, "bringup-bench/1")
	assert.equal(m.target.mcu, "ESP32-C3-MINI-1")
	assert.equal(m.target.programming, "usb-serial-jtag")
	assert.match(m.target.flash, /pio run .* -t upload/)
	assert.deepEqual(m.target.boot, { pin: "GPIO9", level: "low" })
	const st = benchManifest(design(STM32_LOGGER_DESIGN))!
	assert.equal(st.target.programming, "swd")
})

test("each rail has its expected voltage, tolerance and current, and the pad to measure it on", () => {
	const s = design(LOGGER_DESIGN)
	const m = benchManifest(s)!
	const r = m.rails.find((x) => x.name === "3V3")!
	assert.equal(r.expectV, 3.3)
	assert.ok(r.tolV > 0 && r.tolV <= 0.15)
	assert.equal(r.maxMa, LOGGER_DESIGN.rails[0].loadMa)
	assert.equal(r.pad, bringupPads(s).placed.find((p) => p.net === "V3V3")?.ref)
})

test("every bottom pad is listed with its net, kind and place; signals with their pin and part", () => {
	const s = design(LOGGER_DESIGN)
	const m = benchManifest(s)!
	const all = [...recoveryPads(s).placed, ...bringupPads(s).placed]
	assert.equal(m.pads.length, all.length)
	assert.ok(m.pads.some((p) => p.kind === "recovery" && p.net === "GND"))
	assert.ok(m.pads.every((p) => p.side === "bottom" && p.xMm > 0 && p.yMm > 0))
	const sda = m.signals.find((x) => x.net === "I2C_SDA")!
	assert.equal(sda.gpio, 8)
	assert.equal(sda.part, "U2.SDA")
})

test("the I2C devices that should answer, from the catalog, and the bring-up steps in a safe order", () => {
	const m = benchManifest(design(LOGGER_DESIGN))!
	assert.deepEqual(m.expect.i2c, [{ ref: "U2", mpn: "SHT40-AD1B-R2", address: "0x44" }])
	const ids = m.bringup.map((x) => x.id)
	// No power before the rails are checked for a short; flashing only after the rails are right.
	assert.ok(ids.indexOf("short") < ids.indexOf("power"))
	assert.ok(ids.indexOf("rail-3V3") < ids.indexOf("flash"))
	assert.ok(ids.indexOf("flash") < ids.indexOf("i2c-scan"))
	const md = bringupMarkdown(m)
	assert.match(md, /# Bring-up/)
	assert.match(md, /0x44/)
	assert.match(md, /\| TP\d \| V3V3 \|/)
})

test("no outline, no manifest", () => {
	const s = fixtureContract()
	delete s.values.outline
	assert.equal(benchManifest(s), null)
})
