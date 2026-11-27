// The CNC's firmware in the loop (gap 12): grblHAL built for the board (its simulation build: console on USART1, no
// USB, no Trinamic) runs in Renode, and a scenario drives it as a machine would: our settings sent, a move on every axis
// with its step pulses counted per motor, the e-stop pressed and released, a stall injected on the spindle's current, a
// limit tripped. Its known limits are reported with the result, plainly:
//   - Renode 1.17 has no STM32F411: its STM32F412 model (the same core, peripherals and memory map for what grblHAL uses);
//   - no USB model: the simulation's console is USART1;
//   - no TMC2209 model: the drivers' UART is off in this build;
//   - Renode's TIM5 model doesn't reload a down-counter from ARR: a hook in our overlay does (src/tools/cnc-sim.ts);
//   - no ADC model: a small Python one, its value set by the scenario;
//   - its bit-band alias reads 0 for a byte read (grblHAL's pin reads): the simulation's build reads the IDR (BRINGUP_SIM);
//   - GPIOB's pins 13-15 don't reach its EXTI: the scenario drives each input's EXTI line along with the pin.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import type { ContractSnapshot } from "../contract/types.ts"
import { mcuPinName } from "../mcu/pins.ts"
import { grblhalSettings } from "../cnc/grblhal.ts"
import { stallParams } from "../cnc/stall.ts"
import { defaultCheckCatalog } from "../mechanics/checks.ts"
import { buildGrblhal, grblhalReady } from "./grblhal-build.ts"

export const CNC_SIM_LIMITS = [
	"Renode's STM32F412 model stands in for the STM32F411 (Renode 1.17 has none): the same Cortex-M4F core, timers, GPIO and USARTs grblHAL uses",
	"the console is USART1, not USB (Renode has no USB model), so the drivers' Trinamic UART is off in the simulation's build",
	"the TMC2209s aren't simulated: their current, microsteps and UART addresses come from the build, not from a model",
	"Renode's TIM5 doesn't reload a down-counter from ARR; a hook in the simulation's overlay does it",
	"the spindle's current is an injected ADC value, not a motor model",
	"Renode's GPIOB pins 13-15 don't reach its EXTI, so the scenario drives each input's EXTI line along with the pin (the edge the pin makes on the chip)",
	"Renode reads 0 for a byte read of the bit-band alias, so the simulation's build reads input pins from the port's IDR (BRINGUP_SIM); the board's build keeps grblHAL's bit-band read",
] as const

export interface CncSimPlan {
	// The motors' STEP pins (port letter, pin) and the steps a move must give each (the move's mm × steps/mm).
	motors: { name: string; port: string; pin: number; steps: number }[]
	move: string
	limitPin: { port: string; pin: number } | null
	estopPin: { port: string; pin: number } | null
	stallCounts: number
}

const pp = (s: ContractSnapshot, signal: string): { port: string; pin: number } | null => {
	const p = (s.values.pins ?? []).find((x) => x.signal === signal)
	const m = p ? /^P([A-H])(\d+)$/.exec(mcuPinName(s.values.parts ?? [], p.gpio)) : null
	return m ? { port: m[1], pin: Number(m[2]) } : null
}

// The scenario's numbers from the contract and the settings: each motor's expected steps for MOVE_MM, the stall's ADC
// counts (a motor current over the stall trip at half duty, through the INA180's gain and shunt).
export const MOVE_MM = { x: 2, y: 1, z: 0.5 }
export function cncSimPlan(s: ContractSnapshot, stepsPerMm: number[], stall: { thresholdA: number; gainVV: number; shuntOhm: number } | null): CncSimPlan {
	const motors = [
		["X", "X_STEP", MOVE_MM.x * stepsPerMm[0]],
		["Y", "Y1_STEP", MOVE_MM.y * stepsPerMm[1]],
		["Y2 (M3)", "Y2_STEP", MOVE_MM.y * stepsPerMm[1]],
		["Z", "Z_STEP", MOVE_MM.z * stepsPerMm[2]],
	].flatMap(([name, sig, steps]) => {
		const p = pp(s, sig as string)
		return p ? [{ name: name as string, ...p, steps: Math.round(steps as number) }] : []
	})
	// Half duty (S at half the max rpm), a current 10 % over the trip: the shunt's average is that times the duty.
	const counts = stall ? Math.round(((stall.thresholdA * 1.1 * 0.5 * stall.gainVV * stall.shuntOhm) / 3.3) * 4095) : 0
	return { motors, move: `G21 G91 G1 X${MOVE_MM.x} Y${MOVE_MM.y} Z-${MOVE_MM.z} F600`, limitPin: pp(s, "LIMIT_X"), estopPin: pp(s, "ESTOP_TRIP"), stallCounts: counts }
}

export const ADC_PY = `# STM32F4 ADC1 for the simulation: every conversion ends at once (SR.EOC) and reads the value the scenario writes to
# offset 0x3FC (the spindle current amplifier's output, 12-bit counts).
if request.IsInit:
    regs = {}
    inject = 0
elif request.IsWrite:
    if request.Offset == 0x3FC:
        inject = request.Value & 0xFFF
    else:
        regs[request.Offset] = request.Value
elif request.IsRead:
    if request.Offset == 0x00:
        request.Value = 0x2
    elif request.Offset == 0x4C:
        request.Value = inject
    else:
        request.Value = regs.get(request.Offset, 0)
`

export function cncSimRepl(adcPyPath: string): string {
	return `using "platforms/cpus/stm32f412.repl"

dwt: Miscellaneous.DWT @ sysbus 0xE0001000
    frequency: 96000000

adc1: Python.PythonPeripheral @ sysbus 0x40012000
    size: 0x400
    initable: true
    filename: "${adcPyPath}"

timer5:
    frequency: 96000000
`
}

// The scenario as a Renode script; the step counters print as STEPS lines.
export function cncSimScript(o: { repl: string; elf: string; uart: string; settings: string[]; plan: CncSimPlan }): string {
	const ports = [...new Set(o.plan.motors.map((m) => m.port))]
	const count = (port: string) => {
		const bits = o.plan.motors.filter((m) => m.port === port).map((m) => m.pin)
		return `sysbus SetHookBeforePeripheralWrite sysbus.gpioPort${port} "import __builtin__ as b; c = b.__dict__.setdefault('steps${port}', {}); n = value if offset == 0x14 else c.get('odr', 0); [c.__setitem__(k, c.get(k, 0) + 1) for k in ${JSON.stringify(bits)} if (n >> k) & 1 and not (c.get('odr', 0) >> k) & 1]; c['odr'] = n if offset == 0x14 else c.get('odr', 0)"`
	}
	const send = (line: string, s = "0.05") => [`sysbus.usart1 WriteLine "${line}"`, `emulation RunFor "${s}"`]
	// The pin's level (what the firmware reads) and its EXTI line's edge: in Renode 1.17's STM32F4 model GPIOB's pins 13-15
	// don't reach EXTI (their lines never latch; the EXTI itself does), so the script drives the line too, as the pin would.
	const pin = (p: { port: string; pin: number } | null, on: boolean) => (p ? [`sysbus.gpioPort${p.port} OnGPIO ${p.pin} ${on ? "true" : "false"}`, `sysbus.exti OnGPIO ${p.pin} ${on ? "true" : "false"}`] : [])
	return [
		// Errors only: a scenario's peripheral warnings run to megabytes (the flash controller's, every settings write).
		"logLevel 3",
		'mach create "cnc"',
		`machine LoadPlatformDescription @${o.repl}`,
		`sysbus LoadELF @${o.elf}`,
		`sysbus.usart1 CreateFileBackend @${o.uart} true`,
		'sysbus SetHookBeforePeripheralWrite sysbus.timer5 "self.WriteDoubleWord(0x24, value if offset == 0x2C else self.ReadDoubleWord(0x2C)) if offset in (0x10, 0x2C) else None"',
		...ports.map(count),
		'emulation RunFor "2"',
		...o.settings.flatMap((l) => send(l)),
		...send("$X", "0.1"),
		...send(o.plan.move, "1.5"),
		...send("?", "0.05"),
		...ports.map((p) => `python "import __builtin__ as b; print('STEPS ${p}', dict((k, v) for k, v in b.__dict__.get('steps${p}', {}).items() if k != 'odr'))"`),
		...pin(o.plan.estopPin, true),
		'emulation RunFor "0.2"',
		...pin(o.plan.estopPin, false),
		'emulation RunFor "0.2"',
		...send("G1 X1 F600", "0.3"),
		...send("?", "0.05"),
		"sysbus.usart1 WriteChar 0x18",
		'emulation RunFor "0.5"',
		...send("$X", "0.1"),
		...send("M3 S10000", "0.3"),
		`sysbus WriteDoubleWord 0x400123FC ${o.plan.stallCounts}`,
		'emulation RunFor "0.8"',
		...send("?", "0.05"),
		`sysbus WriteDoubleWord 0x400123FC 0`,
		"sysbus.usart1 WriteChar 0x18",
		'emulation RunFor "0.5"',
		...send("$X", "0.1"),
		...send("G1 X5 F600", "0.1"),
		...pin(o.plan.limitPin, true),
		'emulation RunFor "0.3"',
		...send("?", "0.05"),
		"",
	].join("\n")
}

export interface CncSimResult {
	result: "pass" | "fail"
	checks: { name: string; ok: boolean; detail: string }[]
	knownLimits: readonly string[]
}

// The scenario's log: the UART text (with its MARK lines) and the STEPS lines Renode printed.
export function judgeCncSim(uart: string, renodeOut: string, plan: CncSimPlan): CncSimResult {
	const counted = new Map<string, number>()
	for (const m of renodeOut.matchAll(/STEPS ([A-H])', \{([^}]*)\}/g)) for (const kv of m[2].matchAll(/(\d+)L?: (\d+)L?/g)) counted.set(`${m[1]}${kv[1]}`, Number(kv[2]))
	const checks: CncSimResult["checks"] = plan.motors.map((m) => {
		const got = counted.get(`${m.port}${m.pin}`) ?? 0
		return { name: `${m.name} steps`, ok: got === m.steps, detail: `${got} step pulses on P${m.port}${m.pin}, ${m.steps} expected` }
	})
	// grbl echoes nothing, so the phases are told apart by their alarms (10 e-stop, 14 spindle, 1 hard limit). After the
	// e-stop's release the next status must still be an alarm: nothing restarts on its own.
	const e = uart.indexOf("ALARM:10")
	const after = e < 0 ? "" : uart.slice(e)
	const held = /<(Alarm|Estop)[^>]*>/i.test(after.slice(0, after.search(/ALARM:14|GrblHAL 1/) > 0 ? after.search(/ALARM:14|GrblHAL 1/) : undefined))
	checks.push({ name: "e-stop", ok: e >= 0 && held, detail: e < 0 ? "no EStop alarm when pressed" : held ? "pressed: ALARM:10; released: still in alarm, no motion until reset" : "pressed: ALARM:10; released: not in alarm" })
	checks.push({ name: "stall stop", ok: /ALARM:14/.test(uart), detail: /ALARM:14/.test(uart) ? "an injected stall current: spindle off, ALARM:14" : "no spindle alarm on an injected stall current" })
	checks.push({ name: "hard limit", ok: /ALARM:1\b/.test(uart), detail: /ALARM:1\b/.test(uart) ? "X's limit tripped mid-move: ALARM:1" : "no hard-limit alarm" })
	return { result: checks.every((c) => c.ok) ? "pass" : "fail", checks, knownLimits: CNC_SIM_LIMITS }
}

// The cncsim build's artifact (src/agents/builders.ts createCncSimBuilder): the run's result, or why it didn't run.
export interface CncSimArtifact {
	revision: number
	dir: string
	result: "pass" | "fail" | "not run"
	reason: string // the failed checks, or why it didn't run; "" on a pass
	checks: CncSimResult["checks"]
	knownLimits: readonly string[]
	wallS?: number
	stub?: true
}

// The report's lines: the result, each check, the known limits.
export function cncSimLines(a: CncSimArtifact | undefined): string[] {
	if (!a) return []
	if (a.result === "not run") return [`- Simulated machine: not run (${a.reason})`]
	return [
		`- Simulated machine (grblHAL in Renode, rev ${a.revision}): ${a.result === "pass" ? "passes" : "FAILS"}${a.wallS !== undefined ? ` in ${a.wallS} s` : ""}`,
		...a.checks.map((c) => `  - ${c.ok ? "ok" : "**FAILS**"} ${c.name}: ${c.detail}`),
		`  - known limits: ${a.knownLimits.join("; ")}`,
	]
}

export const renodeDir =(root: string) => join(root, "tools/renode/renode_1.17.0-portable")
export const cncSimReady = (root: string) => grblhalReady(root) && existsSync(join(renodeDir(root), "renode"))

// The whole simulation: grblHAL's simulation build in its own copy, the scenario in Renode, the judgement. Its files
// (the script, the overlay, the UART log, Renode's output, result.json) stay in dir.
export function runCncSim(root: string, s: ContractSnapshot, dir: string): CncSimResult & { wallS: number } {
	const t0 = Date.now()
	const wallS = () => Math.round((Date.now() - t0) / 1000)
	const cat = defaultCheckCatalog()
	const settings = cat ? grblhalSettings(s, cat.mech) : null
	if (!cat || !settings) throw new Error("the CNC simulation needs the machine's grblHAL settings (s.values.cnc and the check catalog)")
	const spm = [100, 101, 102].map((id) => settings.find((x) => x.id === id)?.value ?? 0)
	const plan = cncSimPlan(s, spm, stallParams(s, cat))
	const fw = buildGrblhal({ root, dir, s, env: "bringup_cnc_sim" })
	if (!fw.ok) {
		const why = fw.out.split("\n").filter((l) => / error|FAILED/.test(l)).slice(0, 5).join("; ") || fw.out.slice(-400)
		return { result: "fail", checks: [{ name: "simulation build", ok: false, detail: `grblHAL's simulation build failed: ${why}` }], knownLimits: CNC_SIM_LIMITS, wallS: wallS() }
	}
	writeFileSync(join(dir, "adc.py"), ADC_PY)
	writeFileSync(join(dir, "cnc.repl"), cncSimRepl(join(dir, "adc.py")))
	const uart = join(dir, "uart.txt")
	writeFileSync(uart, "")
	writeFileSync(join(dir, "scenario.resc"), cncSimScript({ repl: join(dir, "cnc.repl"), elf: fw.elf, uart, settings: settings.map((x) => `$${x.id}=${x.value}`), plan }))
	const r = spawnSync("./renode", ["--disable-xwt", "--console", "-e", `include @${join(dir, "scenario.resc")}; quit`], { cwd: renodeDir(root), encoding: "utf8", timeout: 900_000, maxBuffer: 256 * 1024 * 1024 })
	const out = `${r.stdout ?? ""}${r.stderr ?? ""}`
	writeFileSync(join(dir, "renode.log"), out)
	const res = { ...judgeCncSim(readFileSync(uart, "utf8"), out, plan), wallS: wallS() }
	writeFileSync(join(dir, "result.json"), JSON.stringify(res, null, 1))
	return res
}
