// What agents are told about the chosen MCU comes from its profile (src/mcu/facts.ts), not from the prompts.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mcuFacts } from "../src/mcu/facts.ts"
import { profileById } from "../src/mcu/profile.ts"
import { searchParts } from "../src/tools/parts-search.ts"

test("ESP32-C3 facts: its strap pins, the 4 MB flash history, its native USB", () => {
	const f = mcuFacts(profileById("esp32-c3-mini-1")!).join("\n")
	assert.match(f, /GPIO9 \(strap\)/)
	assert.match(f, /GPIO4=4/)
	assert.match(f, /radio: ble, wifi/)
	assert.match(f, /Native USB on GPIO19 \(D\+\) \/ GPIO18 \(D-\)/)
})

test("STM32G031 facts: names with their index, SWD reserved, no radio, flashed over SWD", () => {
	const f = mcuFacts(profileById("stm32g031k8t6")!).join("\n")
	assert.match(f, /port×16 \+ number/)
	assert.match(f, /PB7=23/)
	assert.match(f, /PA13 \(swd\), PA14 \(swd\)/)
	assert.match(f, /radio: none/)
	assert.match(f, /Programming: swd \(PA13\/PA14; the board gets SWD pads\)/)
	assert.match(f, /No native USB/)
})

test("the catalog offers every MCU Bringup can build, ESP32 and STM32 alike", async () => {
	const mcus = await searchParts("mcu", { fetch: (async () => { throw new Error("offline") }) as unknown as typeof fetch })
	assert.deepEqual(mcus.map((p) => p.mpn), ["ESP32-C3-MINI-1", "STM32F103C8T6", "STM32G031K8T6", "STM32L031K6T6"])
})
