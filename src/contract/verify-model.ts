// The converted model checked against the design: what py/quantize.py measured (model.json) against the contract's
// planning figures, the flash and RAM the firmware leaves, and the sensor path the design has now. Plain code; the
// result says what fits, what the plan got wrong, and the model field with the measured sizes in place of the plan.
import type { ContractSnapshot, ModelSpec } from "./types.ts"
import { FIRMWARE_BUDGET } from "./model.ts"
import { pathHash, sensorPath } from "./sensor-path.ts"

// py/quantize.py's model.json.
export interface ConvertedModel {
	model: string
	trained: boolean
	quantization: string
	weightsBytes: number
	arenaBytes: number | null
	arenaMeasuredWith?: string
	inputShape: number[]
	inputDtype: string
	calibration: string
	dataset: { pathHash: string; revision: number; clips: number } | null
}

export interface Verdict {
	level: "ok" | "warn" | "fail"
	text: string
}

export interface ModelVerification {
	fits: boolean
	verdicts: Verdict[]
	// The contract's model with the measured weights and arena, when they differ from the plan.
	proposal: ModelSpec | null
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`

export function verifyConverted(f: ConvertedModel, s: ContractSnapshot): ModelVerification {
	const m = s.values.model
	const out: Verdict[] = []
	if (!m) return { fits: false, verdicts: [{ level: "fail", text: "the contract has no model to verify against" }], proposal: null }
	const mcu = (s.values.parts ?? []).find((p) => p.role === "mcu")
	let fits = true

	if (f.quantization !== m.quantization || (m.quantization === "int8" && f.inputDtype !== "int8")) {
		out.push({ level: "fail", text: `the contract plans ${m.quantization}; the converted model is ${f.quantization} with ${f.inputDtype} input` })
		fits = false
	}

	// Flash and RAM: the measured sizes against what the firmware leaves (measured with pio for one MCU).
	if (mcu?.mpn === FIRMWARE_BUDGET.mcu) {
		const flashFree = FIRMWARE_BUDGET.appFlashBytes - FIRMWARE_BUDGET.firmwareFlashBytes
		const ramFree = FIRMWARE_BUDGET.staticRamBytes - FIRMWARE_BUDGET.firmwareRamBytes
		const w = f.weightsBytes <= flashFree
		out.push({ level: w ? "ok" : "fail", text: `weights ${kb(f.weightsBytes)} ${w ? "fit" : "don't fit"} the ${kb(flashFree)} of flash the firmware leaves on the ${mcu.mpn}` })
		fits &&= w
		if (f.arenaBytes === null) out.push({ level: "warn", text: "the tensor arena wasn't measured (install tflite-micro in tools/mlvenv)" })
		else {
			const a = f.arenaBytes <= ramFree
			out.push({ level: a ? "ok" : "fail", text: `tensor arena ${kb(f.arenaBytes)} ${a ? "fits" : "doesn't fit"} the ${kb(ramFree)} of static RAM the firmware leaves` })
			fits &&= a
		}
	} else out.push({ level: "warn", text: `fit not checked: the firmware's flash and RAM use is measured only for the ${FIRMWARE_BUDGET.mcu}` })

	// The plan against the measurement: the firmware reserves the planned sizes (model.h), so a plan below the real
	// model would reserve too little.
	const plannedW = m.weightsKb * 1024
	const plannedA = m.arenaKb * 1024
	out.push({ level: f.weightsBytes > plannedW ? "warn" : "ok", text: `weights measured ${f.weightsBytes} B against the planned ${plannedW} B (${m.weightsKb} KB)${f.weightsBytes > plannedW ? ": the plan is short" : ""}` })
	if (f.arenaBytes !== null) out.push({ level: f.arenaBytes > plannedA ? "warn" : "ok", text: `arena measured ${f.arenaBytes} B against the planned ${plannedA} B (${m.arenaKb} KB)${f.arenaBytes > plannedA ? `: the plan is short by ${f.arenaBytes - plannedA} B` : ""}${f.arenaMeasuredWith ? ` (${f.arenaMeasuredWith})` : ""}` })

	// The data the model learned from (or was calibrated on) belongs to one sensor path.
	const path = sensorPath(s)
	const now = path && pathHash(path)
	if (!f.trained) out.push({ level: "warn", text: `${f.model}: the sizes are real, its answers are not` })
	if (!f.dataset) out.push({ level: "warn", text: `calibration: ${f.calibration}` })
	else if (now && f.dataset.pathHash !== now) {
		out.push({ level: "fail", text: `the dataset was recorded on sensor path ${f.dataset.pathHash} (rev ${f.dataset.revision}); the design's path is ${now}: record data on this hardware first` })
		fits = false
	} else out.push({ level: "ok", text: `the dataset (${f.dataset.clips} clips) was recorded on the design's sensor path ${f.dataset.pathHash}` })

	const weightsKb = Math.ceil(f.weightsBytes / 1024)
	const arenaKb = f.arenaBytes === null ? m.arenaKb : Math.ceil(f.arenaBytes / 1024)
	const proposal = weightsKb !== m.weightsKb || arenaKb !== m.arenaKb ? { ...m, weightsKb, arenaKb } : null
	return { fits, verdicts: out, proposal }
}
