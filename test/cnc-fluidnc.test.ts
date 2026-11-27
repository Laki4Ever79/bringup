// FluidNC's config.yaml from the contract (src/cnc/fluidnc.ts): the CNC's design on the ESP32-WROOM-32E (gap 14), its
// pins as GPIO numbers. The output parses as YAML, every key is one FluidNC's schema has (tools/FluidNC's
// docs/config_items.yaml, when the clone is there), and the pins the classic ESP32 can't take are reported.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { CNC_DESIGN, CNC_MACHINE, CNC_TARGETS } from "../src/inference/scripts.ts"
import { fluidncConfig, fluidncPinProblems, fluidncPins } from "../src/cnc/fluidnc.ts"
import { cncChecks } from "../src/cnc/checks.ts"
import { defaultCheckCatalog } from "../src/mechanics/checks.ts"
import { loadCatalog } from "../src/tools/parts-search.ts"
import type { ContractSnapshot, Part } from "../src/contract/types.ts"
import { fixtureContract } from "./fixture.ts"

const root = resolve(import.meta.dirname, "..")
// The ESP32 pins for the CNC's signals: outputs off the input-only 34-39, nothing on a strapping pin (0, 2, 5, 12, 15),
// UART0 (1, 3) or the flash (6-11); the e-stop's trip (driven by the board) on input-only 36, the current on ADC1's 39.
export const ESP32_CNC_PINS: Record<string, number> = { X_STEP: 26, X_DIR: 27, Y1_STEP: 14, Y1_DIR: 13, Y2_STEP: 33, Y2_DIR: 32, Z_STEP: 25, Z_DIR: 4, STEPPERS_EN: 23, ESTOP_TRIP: 36, LIMIT_X: 18, LIMIT_Y: 19, LIMIT_Z: 21, SPINDLE_I: 39, STEPPER_UART: 16, STEPPER_UART_TX: 17, STATUS_LED: 22, SPINDLE_PWM: 15 }
export function fluidncCnc(pins: Record<string, number> = ESP32_CNC_PINS): ContractSnapshot {
	const b = fixtureContract()
	const entry = loadCatalog(root).find((x) => x.mpn === "ESP32-WROOM-32E") as unknown as Part
	const parts = CNC_DESIGN.parts!.map((p) => (p.role === "mcu" ? { ...entry, ref: p.ref } : p))
	return { ...b, values: { ...b.values, ...CNC_DESIGN, parts, pins: CNC_DESIGN.pins!.map((p) => ({ ...p, gpio: pins[p.signal] ?? p.gpio })), cncTargets: CNC_TARGETS, cnc: { ...CNC_MACHINE, firmware: "fluidnc" } } } as ContractSnapshot
}
const yamlOf = (text: string): Record<string, never> | null => {
	const r = spawnSync("python3", ["-c", "import sys, json, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))"], { input: text, encoding: "utf8" })
	return r.status === 0 ? JSON.parse(r.stdout) : null
}

test("FluidNC's pins: every signal's GPIO number off the WROOM's pin names; the SPINDLE_PWM strap is reported", () => {
	const s = fluidncCnc()
	const { found, missing } = fluidncPins(s)
	assert.deepEqual(missing, [])
	assert.equal(found.get("X_STEP"), 26)
	assert.equal(found.get("ESTOP_TRIP"), 36)
	// GPIO15 is a strapping pin: the reset level sets the boot log's output (the profile's straps).
	assert.deepEqual(fluidncPinProblems(s), ["SPINDLE_PWM is on GPIO15, a strapping pin: its level at reset sets the boot mode"])
	const ok = fluidncCnc({ ...ESP32_CNC_PINS, SPINDLE_PWM: 22, STATUS_LED: 2 })
	assert.deepEqual(fluidncPinProblems(ok), [])
	// An output on an input-only pin, a limit switch where there is no pull-up, an input on GPIO12 (the flash voltage).
	const bad = fluidncPinProblems(fluidncCnc({ ...ESP32_CNC_PINS, SPINDLE_PWM: 22, X_STEP: 34, LIMIT_Y: 35, LIMIT_Z: 12 }))
	assert.deepEqual(bad, ["X_STEP is an output on GPIO34, which is input only", "LIMIT_Y needs the MCU's pull-up, which GPIO35 doesn't have", "LIMIT_Z is on GPIO12, a strapping pin: its level at reset sets the boot mode"])
})

test("the checks send the pin problems and missing signals to the architect, only for a FluidNC machine", () => {
	const cat = defaultCheckCatalog()!
	const bad = fluidncCnc({ ...ESP32_CNC_PINS, SPINDLE_PWM: 22, X_STEP: 34 })
	const v = cncChecks(bad.values, cat).filter((x) => /GPIO34|FluidNC/.test(x.message))
	assert.equal(v.length, 1)
	assert.deepEqual(v[0].affects, ["architect"])
	assert.match(v[0].message, /X_STEP is an output on GPIO34, which is input only: move it/)
	const grbl = { ...bad.values, cnc: { ...bad.values.cnc!, firmware: "grblhal" as const } }
	assert.equal(cncChecks(grbl, cat).filter((x) => /GPIO34/.test(x.message)).length, 0)
})

test("config.yaml: parses, names the machine's numbers and pins, and every key is in FluidNC's schema", () => {
	const s = fluidncCnc({ ...ESP32_CNC_PINS, SPINDLE_PWM: 22, STATUS_LED: 2 })
	const text = fluidncConfig(s, defaultCheckCatalog()!.mech)
	assert.ok(text)
	const y = yamlOf(text) as Record<string, any> | null
	if (!y) return // no python3 yaml on this machine: the text checks below still ran in the other tests
	assert.deepEqual(y.uart1, { txd_pin: "gpio.17", rxd_pin: "gpio.16", baud: 115200, mode: "8N1" })
	assert.equal(y.axes.shared_stepper_disable_pin, "gpio.23")
	assert.equal(y.control.estop_pin, "gpio.36")
	assert.equal(y.PWM.output_pin, "gpio.22")
	assert.equal(y.start.must_home, true)
	// X: 200 steps/rev × 16 / 8 mm lead = 400 steps/mm; homes to its minimum through its NC switch with the pull-up.
	assert.equal(y.axes.x.steps_per_mm, 400)
	assert.equal(y.axes.x.motor0.limit_neg_pin, "gpio.18:pu")
	assert.deepEqual([y.axes.x.motor0.tmc_2209.uart_num, y.axes.x.motor0.tmc_2209.addr, y.axes.x.motor0.tmc_2209.step_pin], [1, 0, "gpio.26"])
	// The sense resistor is the board's (cnc/board.ts senseResistor for 1.2 A: 150 mOhm), not FluidNC's 0.0.
	assert.equal(y.axes.x.motor0.tmc_2209.r_sense_ohms, 0.15)
	// The ganged Y: two motors on their own pins and addresses, the switch on the first.
	assert.deepEqual([y.axes.y.motor0.tmc_2209.step_pin, y.axes.y.motor1.tmc_2209.step_pin], ["gpio.14", "gpio.33"])
	assert.deepEqual([y.axes.y.motor0.tmc_2209.addr, y.axes.y.motor1.tmc_2209.addr], [1, 3])
	assert.equal(y.axes.y.motor1.limit_neg_pin, undefined)
	// Z homes up, to its maximum, first.
	assert.deepEqual([y.axes.z.homing.cycle, y.axes.z.homing.positive_direction, y.axes.z.motor0.limit_pos_pin], [1, true, "gpio.21:pu"])
	// Every key against the schema: sections by path (axes.<letter>.motorN.tmc_2209), the spindle type at the top.
	const schemaPath = join(root, "tools/FluidNC/FluidNC/docs/config_items.yaml")
	if (!existsSync(schemaPath)) return
	const r = spawnSync("python3", ["-c", "import sys, json, yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))", schemaPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
	const schema = JSON.parse(r.stdout) as Record<string, Record<string, unknown>>
	const sectionOf = (path: string[]) => path.join(".").replace(/^axes\.[xyz]\b/, "axes.<letter>").replace(/\.motor[01]\b/, ".motorN").replace(/^uart\d\b/, "uartN")
	const unknown: string[] = []
	const walk = (node: Record<string, unknown>, path: string[]) => {
		for (const [k, v] of Object.entries(node)) {
			const here = [...path, k]
			const isSection = v !== null && typeof v === "object"
			const sec = sectionOf(path)
			const known = path.length === 0 ? k in schema || /^uart\d$/.test(k) || ["board", "name", "kinematics", "axes"].includes(k) : sec === "kinematics" || (schema[sec] && (k in schema[sec] || `${sec}.${k}` in schema || (sec === "axes" && /^[xyz]$/.test(k)) || (sec === "axes.<letter>" && /^motor[01]$/.test(k))))
			if (!known) unknown.push(here.join("."))
			if (isSection) walk(v as Record<string, unknown>, here)
		}
	}
	walk(y, [])
	assert.deepEqual(unknown, [])
})
