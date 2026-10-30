import type { Artifacts } from "../src/contract/consistency.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

// ESP32-C3 logger: the reference design used across tests and the mock run.
export function fixtureContract(): ContractSnapshot {
	return {
		revision: 6,
		versions: { requirements: 1, outline: 1, connectors: 1, rails: 1, parts: 1, pins: 1 },
		values: {
			requirements: { summary: "BLE temperature logger", peripherals: ["i2c-sensor", "usb-c"], batteryLifeDays: 180 },
			outline: { widthMm: 50, heightMm: 30, thicknessMm: 1.6 },
			connectors: [{ ref: "J1", kind: "usb-c", edge: "left", offsetMm: 15, widthMm: 9, heightMm: 3.5 }],
			rails: [{ name: "3V3", voltageV: 3.3, regulatorMaxMa: 500, loadMa: 120 }],
			parts: [
				{ ref: "U1", role: "mcu", mpn: "ESP32-C3-MINI-1", lcsc: "C2838502", footprint: "module", pins: ["GPIO8", "GPIO9", "GPIO10", "3V3", "GND"] },
				{ ref: "U2", role: "sensor", mpn: "SHT40-AD1B-R2", lcsc: "C2909890", footprint: "dfn4", pins: ["SDA", "SCL", "VDD", "VSS"] },
				{ ref: "D1", role: "led", mpn: "KT-0603R", lcsc: "C2286", footprint: "0603", pins: ["A", "K"] },
			],
			pins: [
				{ signal: "I2C_SDA", gpio: 8, partRef: "U2", partPin: "SDA" },
				{ signal: "I2C_SCL", gpio: 9, partRef: "U2", partPin: "SCL" },
			],
		},
	}
}

export function fixtureArtifacts(): Artifacts {
	return {
		board: {
			revision: 6, dir: "/tmp/b", pcbPath: "/tmp/b/board.kicad_pcb", stepPath: null, renderPath: null,
			widthMm: 50, heightMm: 30,
			nets: { I2C_SDA: ["U1.GPIO8", "U2.SDA"], I2C_SCL: ["U1.GPIO9", "U2.SCL"] },
		},
		enclosure: {
			revision: 6, stlPath: "/tmp/e/case.stl", stepPath: "/tmp/e/case.step",
			cutouts: [{ ref: "J1", edge: "left", offsetMm: 15, widthMm: 9.5, heightMm: 4 }],
		},
		firmware: { revision: 6, ok: true, pins: { I2C_SDA: 8, I2C_SCL: 9 }, log: "" },
	}
}
