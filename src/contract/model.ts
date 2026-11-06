// The model in the contract, checked against the rest of the design in plain code: it must fit the flash and RAM the
// firmware leaves, read a sensor the parts list has and the pins wire, at a rate that sensor supports, and its
// listening counts in the battery budget. Each failure is a violation that wakes the agent who can fix it.
import { resolve } from "node:path"
import { loadCatalog } from "../tools/parts-search.ts"
import type { AgentRole, ContractSnapshot, FieldName, ModelSpec } from "./types.ts"
import { pathDiff, pathHash, sensorPath, SENSOR_ROLE } from "./sensor-path.ts"
import { partitionLayout } from "./connectivity.ts"

// What Bringup's own firmware leaves for a model on the ESP32-C3 (env esp32c3 in templates/fw/platformio.ini:
// espressif32@8.0.0, Arduino, NimBLE), measured with `pio run` on the logger design (5 Nov 2026): flash 841,627 of the
// 1,310,720-byte app partition, static RAM 25,760 of 327,680 bytes. The BLE stack also takes heap at runtime, which
// these figures don't include, so a model that takes more than half the free RAM is flagged before it fails to link.
export const FIRMWARE_BUDGET = {
	mcu: "ESP32-C3-MINI-1",
	appFlashBytes: 1_310_720,
	firmwareFlashBytes: 841_627,
	staticRamBytes: 327_680,
	firmwareRamBytes: 25_760,
	measured: "pio run, logger design, espressif32@8.0.0 + NimBLE-Arduino 2.5.2, 5 Nov 2026",
}

// What the firmware takes for each connectivity choice, measured with `pio run` on the logger design (6 Nov 2026,
// espressif32@8.0.0, NimBLE-Arduino 2.5.2, PubSubClient 2.8; the Wi-Fi builds with test credentials so every path
// compiles). The slot comes from the partition table the update choice selects (contract/connectivity.ts).
export const FIRMWARE_FLASH = {
	ble: { flashBytes: 818_569, ramBytes: 24_660, measured: "BLE, GATT + BTHome, no_ota.csv" },
	wifi: { flashBytes: 1_086_059, ramBytes: 37_596, measured: "Wi-Fi, MQTT, no_ota.csv" },
	wifiOta: { flashBytes: 1_188_320, ramBytes: 39_104, measured: "Wi-Fi, MQTT + HTTP update, default.csv" },
}

// The flash and RAM the firmware leaves for a model in this design: the slot the partition table gives, less the
// firmware measured for its radio. Without a connectivity field: the template as it always was (FIRMWARE_BUDGET).
export function firmwareBudget(s?: ContractSnapshot): typeof FIRMWARE_BUDGET {
	const c = s?.values.connectivity
	if (!s || !c) return FIRMWARE_BUDGET
	const fw = c.radio === "ble" ? FIRMWARE_FLASH.ble : c.updates === "ota" ? FIRMWARE_FLASH.wifiOta : FIRMWARE_FLASH.wifi
	return { ...FIRMWARE_BUDGET, appFlashBytes: partitionLayout(s).appBytes, firmwareFlashBytes: fw.flashBytes, firmwareRamBytes: fw.ramBytes, measured: `pio run, logger design, ${fw.measured}, 6 Nov 2026` }
}

export interface ModelBudget {
	flashFreeKb: number
	ramFreeKb: number
	weightsShare: number
	arenaShare: number
}

export function modelBudget(m: ModelSpec, s?: ContractSnapshot): ModelBudget {
	const b = firmwareBudget(s)
	const flashFreeKb = (b.appFlashBytes - b.firmwareFlashBytes) / 1024
	const ramFreeKb = (b.staticRamBytes - b.firmwareRamBytes) / 1024
	return { flashFreeKb, ramFreeKb, weightsShare: m.weightsKb / flashFreeKb, arenaShare: m.arenaKb / ramFreeKb }
}


// The I2S lines a microphone's data needs, by the catalog's pin names.
const I2S_LINES = ["SCK", "WS", "SD"]

interface CatalogMic {
	mpn: string
	rateRangesHz?: [number, number][]
	lowPowerUa?: number
	highPerfUa?: number
	sleepUa?: number
}

// The catalog beside the code, as design-facts.ts reads it.
const catalog = () => loadCatalog(resolve(import.meta.dirname, "../..")) as unknown as (CatalogMic & { role: string; cpuMa?: number })[]

export interface ModelViolation {
	kind: "model-flash" | "model-ram" | "model-sensor-missing" | "model-sensor-unwired" | "model-rate" | "model-stale"
	message: string
	fields: FieldName[]
	affects: AgentRole[]
}

const kb = (x: number) => `${Number(x.toPrecision(3))} KB`

export function modelChecks(s: ContractSnapshot): ModelViolation[] {
	const m = s.values.model
	if (!m) return []
	const out: ModelViolation[] = []
	const parts = s.values.parts ?? []
	const pins = s.values.pins ?? []
	const mcu = parts.find((p) => p.role === "mcu")
	// The budget is measured for one MCU; on another the fit can't be checked yet (the facts say so).
	if (mcu?.mpn === FIRMWARE_BUDGET.mcu) {
		const b = modelBudget(m, s)
		if (b.weightsShare > 1) {
			// With field updates on, the flash holds two firmware slots: one slot with no updates might hold the model.
			const c = s.values.connectivity
			const without = c?.updates === "ota" ? modelBudget(m, { ...s, values: { ...s.values, connectivity: { ...c, updates: "none" } } }) : null
			const slot = without && without.weightsShare <= 1 ? `; with no field updates (connectivity.updates "none") the firmware gets one bigger slot, which leaves ${kb(without.flashFreeKb)}` : ""
			out.push({ kind: "model-flash", message: `model weights ${kb(m.weightsKb)} don't fit the ${kb(b.flashFreeKb)} of flash the firmware leaves on the ${mcu.mpn}: quantize (int8 is about a quarter of float32), prune, or pick a smaller model${slot}`, fields: slot ? ["model", "connectivity"] : ["model"], affects: slot ? ["ml", "connectivity"] : ["ml"] })
		}
		if (b.arenaShare > 1)
			out.push({ kind: "model-ram", message: `the tensor arena ${kb(m.arenaKb)} doesn't fit the ${kb(b.ramFreeKb)} of static RAM the firmware leaves on the ${mcu.mpn}: shrink the input window or the model`, fields: ["model"], affects: ["ml"] })
	}
	const sensor = parts.find((p) => SENSOR_ROLE[m.sensor].includes(p.role))
	if (!sensor) {
		out.push({ kind: "model-sensor-missing", message: `the model reads a ${m.sensor} and the parts list has none: add one (search_parts role ${SENSOR_ROLE[m.sensor][0]})`, fields: ["parts", "model"], affects: ["parts"] })
		return out
	}
	if (m.sensor === "microphone") {
		const wired = new Set(pins.filter((p) => p.partRef === sensor.ref).map((p) => p.partPin))
		const missing = I2S_LINES.filter((l) => sensor.pins.includes(l) && !wired.has(l))
		if (missing.length)
			out.push({ kind: "model-sensor-unwired", message: `the microphone ${sensor.ref} (${sensor.mpn}) needs its I2S ${missing.join(", ")} on MCU pins: add them to pins`, fields: ["pins"], affects: ["architect"] })
		const ranges = catalog().find((c) => c.mpn === sensor.mpn)?.rateRangesHz
		if (ranges && !ranges.some(([lo, hi]) => m.sampleRateHz >= lo && m.sampleRateHz <= hi))
			out.push({ kind: "model-rate", message: `the model samples at ${m.sampleRateHz} Hz, which the ${sensor.mpn} doesn't support (${ranges.map(([lo, hi]) => `${lo}–${hi} Hz`).join(" or ")}): resample the training data to a supported rate`, fields: ["model"], affects: ["ml"] })
	}
	// The training data belongs to the sensor path it was recorded on. A board or case change that moves the path
	// leaves the model trained for a device that no longer exists, which no accuracy number in the build shows.
	const now = sensorPath(s)
	if (m.data && now && m.data.pathHash !== pathHash(now)) {
		const changed = pathDiff(m.data.path, now).join(", ")
		out.push({
			kind: "model-stale",
			message: m.data.status === "recorded"
				? `the model's training data was recorded on rev ${m.data.revision}'s sensor path (${m.data.pathHash}), and the hardware has moved since (${changed}): mark the data needed on the new path (${pathHash(now)}), so the data-collection firmware records it`
				: `the data collection targets rev ${m.data.revision}'s sensor path (${m.data.pathHash}), and the hardware has moved since (${changed}): retarget it to the new path (${pathHash(now)})`,
			fields: ["model"],
			affects: ["ml"],
		})
	}
	return out
}

// What listening costs the battery, in mA on average, on top of the duty cycle the rails already count.
// "always": the MCU stays awake (catalog cpuMa) and the microphone runs in its mode for the rate; "on-wake": both run
// for one window per wake, and the microphone sleeps the rest of the time.
export function modelCurrentMa(s: ContractSnapshot): { averageMa: number; how: string } | null {
	const m = s.values.model
	if (!m) return null
	const parts = s.values.parts ?? []
	const cat = catalog()
	const mcu = parts.find((p) => p.role === "mcu")
	const cpuMa = cat.find((c) => c.mpn === mcu?.mpn)?.cpuMa
	const micPart = m.sensor === "microphone" ? parts.find((p) => p.role === "microphone") : undefined
	const mic = micPart && cat.find((c) => c.mpn === micPart.mpn)
	const micUa = mic ? (m.sampleRateHz <= 18750 ? mic.lowPowerUa : mic.highPerfUa) ?? 0 : 0
	if (cpuMa === undefined) return null
	const listenMa = cpuMa + micUa / 1000
	if (m.listening === "always") return { averageMa: listenMa, how: `always listening: the MCU awake at ${cpuMa} mA plus the microphone's ${micUa} µA, all the time` }
	const period = s.values.requirements?.dutyCycle?.periodS
	if (!period) return null
	const share = m.windowMs / (period * 1000)
	const asleep = ((mic?.sleepUa ?? 0) / 1000) * (1 - share)
	return { averageMa: listenMa * share + asleep, how: `one ${m.windowMs} ms window per ${period} s wake at ${Number(listenMa.toPrecision(3))} mA, the microphone asleep (${mic?.sleepUa ?? 0} µA) otherwise` }
}

// Lines for the design facts every agent turn ends with.
export function modelFactLines(s: ContractSnapshot): string[] {
	const m = s.values.model
	if (!m) return []
	const mcu = (s.values.parts ?? []).find((p) => p.role === "mcu")
	const out = [`- Model: ${m.task}; ${m.sensor} at ${m.sampleRateHz} Hz, ${m.windowMs} ms window × ${m.channels}; weights ${kb(m.weightsKb)}, arena ${kb(m.arenaKb)} (${m.quantization}, ${m.runtime}); listening ${m.listening}.`]
	if (mcu?.mpn === FIRMWARE_BUDGET.mcu) {
		const b = modelBudget(m, s)
		out.push(`- It fits: weights ${(b.weightsShare * 100).toFixed(0)}% of the ${kb(b.flashFreeKb)} flash and arena ${(b.arenaShare * 100).toFixed(0)}% of the ${kb(b.ramFreeKb)} static RAM the firmware leaves (measured: ${FIRMWARE_BUDGET.measured}).${b.arenaShare > 0.5 ? " The BLE stack's runtime heap isn't in that figure, so above half is tight." : ""}`)
	} else out.push(`- Its fit isn't checked: the firmware's flash and RAM use is measured only for the ${FIRMWARE_BUDGET.mcu}.`)
	const path = sensorPath(s)
	if (path) {
		const hash = pathHash(path)
		const data = m.data ? (m.data.pathHash === hash ? `the training data is ${m.data.status} on this path (rev ${m.data.revision})` : `the training data is ${m.data.status} on an older path (${m.data.pathHash}, rev ${m.data.revision})`) : "no training data is recorded against it yet"
		out.push(`- The model's sensor path now (hash ${hash}): ${JSON.stringify(path)}; ${data}.`)
	}
	const power = modelCurrentMa(s)
	if (power) out.push(`- Listening adds ${Number(power.averageMa.toPrecision(3))} mA on average to the battery budget (${power.how}).`)
	return out
}
