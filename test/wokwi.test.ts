import { test } from "node:test"
import assert from "node:assert/strict"
import { firmwareSimBackend, describeEnv, type Env } from "../src/tools/env.ts"
import { sensorReading, SIM_READING, wokwiProject } from "../src/codegen/wokwi.ts"
import { fixtureContract } from "./fixture.ts"

const env = (over: Partial<Env>): Env => ({ root: "/r", tsci: null, kicad: null, python: null, pio: null, ...over })

test("the firmware-sim backend: Wokwi with a token and the repo-local CLI, else QEMU boot-only, else none", () => {
	assert.equal(firmwareSimBackend(env({ wokwi: "/r/tools/wokwi-cli/wokwi-cli", wokwiToken: true, qemu: "/q" })), "wokwi")
	assert.equal(firmwareSimBackend(env({ wokwi: "/r/tools/wokwi-cli/wokwi-cli", wokwiToken: false, qemu: "/q" })), "qemu", "no token: QEMU")
	assert.equal(firmwareSimBackend(env({ wokwi: null, wokwiToken: true, qemu: "/q" })), "qemu", "no CLI: QEMU")
	assert.equal(firmwareSimBackend(env({ wokwi: null, wokwiToken: false, qemu: null })), null)
})

test("describeEnv says whether Wokwi can run, and never prints the token", () => {
	const old = process.env.WOKWI_CLI_TOKEN
	process.env.WOKWI_CLI_TOKEN = "wok_secret_1234"
	try {
		const text = describeEnv(env({ wokwi: "/r/tools/wokwi-cli/wokwi-cli", wokwiToken: true }))
		assert.match(text, /^Wokwi: +\/r\/tools\/wokwi-cli\/wokwi-cli \(token set\)$/m)
		assert.doesNotMatch(text, /wok_secret/)
		assert.match(describeEnv(env({ wokwi: null, wokwiToken: false })), /^Wokwi: +not set up \(optional: WOKWI_CLI_TOKEN in \.env and tools\/wokwi-cli, see NOTES\.md\)$/m)
	} finally {
		if (old === undefined) delete process.env.WOKWI_CLI_TOKEN
		else process.env.WOKWI_CLI_TOKEN = old
	}
})

test("the Wokwi project comes from the contract: the C3, the contract's sensor chip on its I2C pins, power and ground", () => {
	const c = fixtureContract() // SHT40 on I2C_SDA GPIO8, I2C_SCL GPIO9
	const p = wokwiProject(c, "../.pio/build/esp32c3")
	assert.match(p.toml, /^firmware = '\.\.\/\.pio\/build\/esp32c3\/firmware\.bin'$/m)
	assert.match(p.toml, /^elf = '\.\.\/\.pio\/build\/esp32c3\/firmware\.elf'$/m)
	assert.match(p.toml, /^\[\[chip\]\]\nname = 'sht40'\nbinary = 'chips\/sht40\.chip\.wasm'$/m)
	const d = JSON.parse(p.diagram)
	assert.deepEqual(d.parts.map((x: { type: string; id: string }) => [x.type, x.id]), [["board-esp32-c3-devkitm-1", "esp"], ["chip-sht40", "U2"]])
	const wires = d.connections.map((w: string[]) => `${w[0]}-${w[1]}`)
	for (const w of ["esp:8-U2:SDA", "esp:9-U2:SCL", "esp:3V3.1-U2:VDD", "esp:GND.1-U2:GND"]) assert.ok(wires.includes(w), `${w} in ${wires.join(", ")}`)
	const shtc3 = fixtureContract()
	shtc3.values.parts = shtc3.values.parts!.map((x) => (x.role === "sensor" ? { ...x, mpn: "SHTC3-TR-2.5KS" } : x))
	assert.equal(JSON.parse(wokwiProject(shtc3, "x").diagram).parts[1].type, "chip-shtc3")
})

// The fixed reading the simulated sensor reports, encoded the way each datasheet says and decoded the way
// templates/fw/src/main.cpp decodes it, so the serial line to expect is known in advance.
test("the simulated sensors answer a known reading that the firmware decodes to SENSOR OK 21.50 C 48.0 %RH", () => {
	const crc8 = (b: number[]) => {
		let crc = 0xff
		for (const x of b) {
			crc ^= x
			for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x31) & 0xff : (crc << 1) & 0xff
		}
		return crc
	}
	for (const driver of ["SHT40", "SHTC3"] as const) {
		const bytes = sensorReading(driver, SIM_READING.tempC, SIM_READING.rh)
		assert.equal(bytes.length, 6)
		assert.equal(bytes[2], crc8(bytes.slice(0, 2)))
		assert.equal(bytes[5], crc8(bytes.slice(3, 5)))
		const rawT = (bytes[0] << 8) | bytes[1]
		const rawRh = (bytes[3] << 8) | bytes[4]
		const t = driver === "SHTC3" ? -45 + 175 * (rawT / 65536) : -45 + 175 * (rawT / 65535)
		const rh = driver === "SHTC3" ? 100 * (rawRh / 65536) : -6 + 125 * (rawRh / 65535)
		assert.equal(`SENSOR OK ${t.toFixed(2)} C ${rh.toFixed(1)} %RH`, "SENSOR OK 21.50 C 48.0 %RH", driver)
	}
})

test("the custom chips' C sources carry exactly the bytes sensorReading computes", async () => {
	const { readFileSync } = await import("node:fs")
	for (const driver of ["SHT40", "SHTC3"] as const) {
		const c = readFileSync(new URL(`../templates/wokwi/chips/${driver.toLowerCase()}.chip.c`, import.meta.url), "utf8")
		const bytes = /READING\[6\] = \{([^}]+)\}/.exec(c)![1].split(",").map((x) => Number(x.trim()))
		assert.deepEqual(bytes, sensorReading(driver, SIM_READING.tempC, SIM_READING.rh), driver)
	}
})

test("without a token, or without the CLI, simulation is skipped with the reason in words", async () => {
	const { simulateFirmware } = await import("../src/tools/wokwi.ts")
	const c = fixtureContract()
	assert.deepEqual(await simulateFirmware(env({ wokwi: "/r/tools/wokwi-cli/wokwi-cli", wokwiToken: false }), "/nope", c), { ran: false, reason: "no WOKWI_CLI_TOKEN in .env; optional, see NOTES.md" })
	assert.deepEqual(await simulateFirmware(env({ wokwi: null, wokwiToken: true }), "/nope", c), { ran: false, reason: "wokwi-cli is not installed in tools/wokwi-cli; optional, see NOTES.md" })
})

test("the report says which firmware simulator ran, or why none did", async () => {
	const { simulationLine } = await import("../src/report.ts")
	const { mkdtempSync, writeFileSync } = await import("node:fs")
	const { tmpdir } = await import("node:os")
	const { join } = await import("node:path")
	const dir = mkdtempSync(join(tmpdir(), "sim-"))
	assert.equal(simulationLine(dir, env({ wokwi: null, wokwiToken: false })), "- Firmware simulation (Wokwi): not run (no WOKWI_CLI_TOKEN in .env; optional, see NOTES.md)")
	writeFileSync(join(dir, "simulation.json"), JSON.stringify({ backend: "wokwi", ran: true, passed: true, revision: 7 }))
	assert.equal(simulationLine(dir, env({})), "- Firmware simulation (Wokwi): rev 7 passed: SENSOR OK 21.50 C 48.0 %RH from the simulated sensor, and a history slot stored")
	writeFileSync(join(dir, "simulation.json"), JSON.stringify({ backend: "wokwi", ran: true, passed: false, revision: 7 }))
	assert.match(simulationLine(dir, env({})), /rev 7 FAILED/)
})
