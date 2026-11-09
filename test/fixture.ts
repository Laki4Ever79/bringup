import type { Artifacts } from "../src/contract/consistency.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

// ESP32-C3 logger: the reference design used across tests and the mock run.
export function fixtureContract(): ContractSnapshot {
	return {
		revision: 6,
		versions: { requirements: 1, outline: 1, connectors: 1, rails: 1, parts: 1, pins: 1, behavior: 0, model: 0, test: 0, case: 0, connectivity: 0, links: 0, motion: 0, mechanics: 0 },
		values: {
			requirements: { summary: "BLE temperature logger", peripherals: ["i2c-sensor", "usb-c"], batteryLifeDays: 180 },
			outline: { widthMm: 50, heightMm: 30, thicknessMm: 1.6, sizeReason: { kind: "engineer-size", detail: "the brief asks for about 50 × 30 mm" } },
			connectors: [{ ref: "J1", kind: "usb-c", edge: "left", offsetMm: 15, widthMm: 9, heightMm: 3.5 }],
			// 200 mA: the module transmitting Bluetooth LE peaks at 170 mA (ESP32-C3-MINI-1 datasheet v2.2).
			rails: [{ name: "3V3", voltageV: 3.3, regulatorMaxMa: 500, loadMa: 200 }],
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

// A small indoor rover for the mechanics checks: one board with a DRV8833-class driver and a VL53L0X-class sensor, two
// N20-class motors, 60 mm wheels, a 25 mm swivel caster, one 1S cell. Its catalog numbers are test values, not a real
// datasheet's (the real ones are in catalog/mechanics.json).
export function roverFixture() {
	const cite = { url: "https://example.com/ds", where: "test value" }
	const cat = {
		mech: {
			motors: [{ mpn: "M-TEST", ratedV: 6, noLoadRpm: 320, stallTorqueNm: 0.17, stallA: 1.6, noLoadA: 0.07, gearRatio: 100, bodyMm: [34, 12, 10] as [number, number, number], shaftMm: 3, massG: 10, source: { ratedV: cite } }],
			wheels: [{ mpn: "W-TEST", diameterMm: 60, widthMm: 8, shaftMm: 3, massG: 12, tread: "rubber" as const, source: {} }],
			casters: [{ mpn: "C-TEST", wheelMm: 25, heightMm: 36, swivel: true as const, holesMm: [[-10, 0], [10, 0]] as [number, number][], massG: 15, source: {} }],
			sensors: [{ mpn: "S-TEST", chip: "VL53L0X", rangeMm: 1200, fovDeg: 25, updateMs: 33, i2cAddress: 41, sizeMm: [21, 18, 2.8] as [number, number, number], massG: 1.3, connector: "JST SH 4", source: {} }],
			batteries: [{ mpn: "B-TEST", cells: 1 as const, nominalV: 3.7, fullV: 4.2, cutoffV: 3.0, mAh: 1200, maxContA: 3, peakA: 6, sizeMm: [50, 34, 7] as [number, number, number], massG: 25, source: {} }],
		},
		boardParts: [
			{ mpn: "DRV-TEST", role: "motor-driver", supplyMinV: 2.7, supplyMaxV: 10.8, channels: 2, contA: 1.5, peakA: 2, rdsOnOhm: 0.36 },
		],
	}
	const c = fixtureContract()
	const values = c.values as Record<string, unknown> & typeof c.values
	values.outline = { widthMm: 60, heightMm: 40, thicknessMm: 1.6 }
	values.parts = [
		...c.values.parts!,
		{ ref: "U3", role: "motor-driver", mpn: "DRV-TEST", lcsc: null, footprint: "htssop16", pins: ["AIN1", "AIN2", "BIN1", "BIN2", "AOUT1", "AOUT2", "BOUT1", "BOUT2", "VM", "GND"] },
		{ ref: "JT1", role: "connector", mpn: "SM04B-SRSS-TB(LF)(SN)", lcsc: "C160404", footprint: "jst4_sh", pins: ["GND", "VCC", "IO1", "IO2"] },
		{ ref: "J2", role: "battery", mpn: "S2B-PH", lcsc: null, footprint: "jst-ph-2", pins: ["+", "-"] },
	]
	values.pins = [
		...c.values.pins!,
		{ signal: "I2C_SDA", gpio: 8, partRef: "JT1", partPin: "IO1" },
		{ signal: "I2C_SCL", gpio: 9, partRef: "JT1", partPin: "IO2" },
		{ signal: "MOT_AIN1", gpio: 4, partRef: "U3", partPin: "AIN1" },
		{ signal: "MOT_AIN2", gpio: 5, partRef: "U3", partPin: "AIN2" },
		{ signal: "MOT_BIN1", gpio: 6, partRef: "U3", partPin: "BIN1" },
		{ signal: "MOT_BIN2", gpio: 7, partRef: "U3", partPin: "BIN2" },
	]
	values.motion = { speedMps: 0.3, runtimeMin: 30, edgeMm: 10, maxSlopeDeg: 5, stopBeforeWallMm: 150, payloadG: 20, maxSizeMm: [170, 150], maxMassG: 500 }
	values.mechanics = {
		drive: { kind: "differential", motor: "M-TEST", wheel: "W-TEST", caster: "C-TEST", trackMm: 130, wheelbaseMm: 90, axleXMm: 30 },
		battery: { pack: "B-TEST", at: { xMm: -10, yMm: 0 } },
		sensor: { module: "S-TEST", at: { xMm: 72, yMm: 0, zMm: 50 }, connector: "JT1" },
		chassis: { plateMm: [150, 110], thicknessMm: 3, material: "PLA", clearanceMm: 36, boards: [{ name: "main", at: { xMm: 10, yMm: 0 }, rotDeg: 0 }] },
	}
	return { c, cat }
}
