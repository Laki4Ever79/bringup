// MCU profiles (docs/mcu.md): one data file per orderable chip or module, the only place chip facts live.
import { test } from "node:test"
import assert from "node:assert/strict"
import { loadProfiles, mcuProfileOf, profileById, profileForPart } from "../src/mcu/profile.ts"

const stm = () => {
	const p = profileById("stm32g031k8t6")
	assert.ok(p, "stm32g031k8t6 profile exists")
	return p
}

test("STM32G031K8 pins carry ST's names, the port×16+n index and their LQFP32 pads", () => {
	const p = stm()
	const pin = (n: string) => p.pins.find((x) => x.name === n)
	assert.equal(pin("PA5")?.index, 5)
	assert.equal(pin("PB3")?.index, 19)
	assert.deepEqual(pin("PB9")?.pads, ["1"])
	assert.ok(pin("PB7")?.signals.includes("I2C1_SDA"))
	assert.equal(p.package.footprint, "lqfp32_w7.05mm_h7.05mm_p0.8mm_pl1.475mm_pw0.55mm")
	assert.equal(p.vendor, "st")
})

test("STM32G031K8 peripherals come from ST's instance list", () => {
	const p = stm()
	assert.deepEqual(p.peripherals.i2c, ["I2C1", "I2C2"])
	assert.ok(p.peripherals.uart.includes("USART1") && p.peripherals.uart.includes("USART2"))
	assert.deepEqual(p.peripherals.radio, [])
})

test("SWD and reset pins are reserved, never offered to a design", () => {
	const p = stm()
	assert.equal(p.pins.find((x) => x.name === "PA13")?.reserved, "swd")
	assert.equal(p.pins.find((x) => x.name === "PA14")?.reserved, "swd")
	assert.equal(p.pins.find((x) => x.name === "PF2")?.reserved, "reset")
})

test("a part from before profiles resolves by its MPN; unknown parts give null", () => {
	assert.equal(profileForPart({ mpn: "ESP32-C3-MINI-1" })?.id, "esp32-c3-mini-1")
	assert.equal(profileForPart({ mpn: "STM32G031K8T6" })?.id, "stm32g031k8t6")
	assert.equal(profileForPart({ mpn: "NOPE" }), null)
	assert.equal(mcuProfileOf([{ role: "sensor", mpn: "SHT40-AD1B-R2" }, { role: "mcu", mpn: "ESP32-C3-MINI-1" }])?.id, "esp32-c3-mini-1")
	assert.equal(mcuProfileOf([]), null)
})

test("every profile is sourced and self-consistent", () => {
	const all = loadProfiles()
	assert.ok(all.length >= 7, `profiles: ${all.map((p) => p.id).join(", ")}`)
	for (const p of all) {
		assert.ok(p.sources.length > 0, `${p.id} sources`)
		assert.ok(p.currents.source.length > 0, `${p.id} currents.source`)
		const idx = p.pins.map((x) => x.index)
		assert.equal(new Set(idx).size, idx.length, `${p.id} unique pin indexes`)
		const pads = [...p.pins.flatMap((x) => x.pads), ...p.power.flatMap((x) => x.pads)]
		assert.equal(new Set(pads).size, pads.length, `${p.id} unique pads: ${pads.join(",")}`)
		assert.ok(["esp32", "stm32", "rp2040", "nrf52"].includes(p.firmware.arch), p.id)
	}
})
