import type { ContractSnapshot } from "../contract/types.ts"
import { sensorDriver } from "./firmware.ts"

// A Wokwi project generated from the contract, so the simulated circuit always matches the design: the ESP32-C3 and
// the contract's temperature/humidity sensor on the contract's I2C pins. Wokwi has no SHT40 or SHTC3, so the sensor
// is a custom chip (templates/wokwi/chips) that answers the sensor's I2C commands with SIM_READING.

export const SIM_READING = { tempC: 21.5, rh: 48.0 }

// The six bytes a sensor sends for a reading (T, CRC, RH, CRC), encoded per its datasheet. The custom chips send the
// same bytes for SIM_READING; the test checks the firmware decodes them back.
export function sensorReading(driver: "SHT40" | "SHTC3", tempC: number, rh: number): number[] {
	const rawT = driver === "SHTC3" ? Math.round(((tempC + 45) / 175) * 65536) : Math.round(((tempC + 45) / 175) * 65535)
	const rawRh = driver === "SHTC3" ? Math.round((rh / 100) * 65536) : Math.round(((rh + 6) / 125) * 65535)
	const crc8 = (b: number[]) => {
		let crc = 0xff
		for (const x of b) {
			crc ^= x
			for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x31) & 0xff : (crc << 1) & 0xff
		}
		return crc
	}
	const t = [rawT >> 8, rawT & 0xff]
	const h = [rawRh >> 8, rawRh & 0xff]
	return [...t, crc8(t), ...h, crc8(h)]
}

// wokwi.toml and diagram.json; firmwareDir is relative to the project folder (PlatformIO's build output).
export function wokwiProject(s: ContractSnapshot, firmwareDir: string): { toml: string; diagram: string; chip: string | null } {
	const sensor = (s.values.parts ?? []).find((p) => p.role === "sensor")
	const driver = sensor ? sensorDriver(sensor.mpn) : null
	const chip = driver ? driver.toLowerCase() : null
	const pin = (signal: string) => (s.values.pins ?? []).find((p) => p.signal === signal)?.gpio
	const toml = [
		"[wokwi]",
		"version = 1",
		// The merged flash image (bootloader, partition table, app), so the LittleFS partition for the history exists.
		`firmware = '${firmwareDir}/flash.bin'`,
		`elf = '${firmwareDir}/firmware.elf'`,
		...(chip ? ["", "[[chip]]", `name = '${chip}'`, `binary = 'chips/${chip}.chip.wasm'`] : []),
		"",
	].join("\n")
	const parts: object[] = [{ type: "board-esp32-c3-devkitm-1", id: "esp", top: 0, left: 0, attrs: {} }]
	const connections: [string, string, string, string[]][] = [["esp:TX", "$serialMonitor:RX", "", []], ["esp:RX", "$serialMonitor:TX", "", []]]
	if (chip && sensor) {
		parts.push({ type: `chip-${chip}`, id: sensor.ref, top: 0, left: 200, attrs: {} })
		const sda = pin("I2C_SDA")
		const scl = pin("I2C_SCL")
		if (sda !== undefined) connections.push([`esp:${sda}`, `${sensor.ref}:SDA`, "green", []])
		if (scl !== undefined) connections.push([`esp:${scl}`, `${sensor.ref}:SCL`, "blue", []])
		connections.push(["esp:3V3.1", `${sensor.ref}:VDD`, "red", []], ["esp:GND.1", `${sensor.ref}:GND`, "black", []])
	}
	return { toml, diagram: JSON.stringify({ version: 1, author: "Bringup", editor: "wokwi", parts, connections }, null, 2), chip }
}
