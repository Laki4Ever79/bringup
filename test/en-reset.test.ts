// The ESP32 module's reset pin (engineer, 13 Nov 2026: "regarding chip reset pin, sure, we can do it"): EN gets Espressif's
// RC delay, 10 kΩ to 3V3 and 1 µF to GND (ESP32-C3-MINI-1 datasheet, peripheral schematics), instead of a straight tie
// to 3V3. The chip starts only once its supply is up, and a debug cable can pull EN low to reset it.
import { test } from "node:test"
import assert from "node:assert/strict"
import { boardParts, circuitFromContract, generatedNets, supportParts } from "../src/codegen/circuit.ts"
import { addedForYou } from "../src/contract/added.ts"
import { LOGGER_DESIGN, STM32_LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { fixtureContract } from "./fixture.ts"

const design = (d: typeof LOGGER_DESIGN) => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(d) }
	return s
}

test("an ESP32 module's EN gets 10k to 3V3 and 1uF to GND, not a straight tie", () => {
	const s = design(LOGGER_DESIGN)
	const nets = generatedNets(s)
	assert.ok(!nets.get("V3V3")!.includes("U1.EN"), "EN no longer tied straight to the rail")
	assert.ok(nets.get("MCU_EN")!.includes("U1.EN"))
	const rc = supportParts(s).filter((x) => [x.a, x.b].some((e) => "net" in e && e.net === "MCU_EN"))
	assert.equal(rc.length, 2)
	const r = rc.find((x) => x.spec.kind === "resistor")!
	const c = rc.find((x) => x.spec.kind === "capacitor")!
	assert.equal(r.spec.value, "10k")
	assert.deepEqual(r.b, { net: "V3V3" })
	assert.equal(c.spec.value, "1uF")
	assert.deepEqual(c.b, { net: "GND" })
	assert.ok(boardParts(s).some((p) => p.ref === r.ref) && boardParts(s).some((p) => p.ref === c.ref), "both on the board (the scripted logger lists them; a design that doesn't gets them added)")
	assert.match(circuitFromContract(s), /net\.MCU_EN/)
})

test("an STM32 board has no EN, so no RC", () => {
	const s = design(STM32_LOGGER_DESIGN)
	assert.equal(generatedNets(s).get("MCU_EN")?.length ?? 0, 0)
	assert.ok(!supportParts(s).some((x) => [x.a, x.b].some((e) => "net" in e && e.net === "MCU_EN")))
})

test("the report says why the reset RC is there", () => {
	const item = addedForYou(design(LOGGER_DESIGN)).find((i) => i.id === "en-reset")
	assert.ok(item)
	assert.match(item.why, /Espressif/)
	assert.match(item.shows, /10 ?k/)
	assert.equal(addedForYou(design(STM32_LOGGER_DESIGN)).find((i) => i.id === "en-reset"), undefined)
})

test("a design that doesn't list the RC gets it added", () => {
	const s = design(LOGGER_DESIGN)
	s.values.parts = s.values.parts!.filter((p) => p.ref !== "R10" && p.ref !== "C4")
	const added = boardParts(s).filter((p) => p.added)
	assert.deepEqual(added.map((p) => p.value).sort(), ["10k", "1uF"])
})
