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
import { motorLabels } from "../cnc/signals.ts"
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
	"grblHAL's DIR pins never show in Renode's GPIO register (PB10's set by a byte write), so the toolpath's shape comes from grblHAL's own position reports and the STEP pins only measure each axis's length (bringup-cad, a2648e36)",
	"port A's STEP pulses are set without Renode seeing it and cleared by ODR writes, so the toolpath's pulse count reads the port's real register (bringup-cad, a2648e36)",
] as const

export interface CncSimPlan {
	// The motors' STEP pins (port letter, pin) and the steps a move must give each (the move's mm × steps/mm).
	motors: { name: string; port: string; pin: number; steps: number }[]
	move: string
	limitPin: { port: string; pin: number } | null
	estopPin: { port: string; pin: number } | null
	stallCounts: number
	// The toolpath's recording (get_pictures): one motor per axis (a gantry's first), its STEP and DIR pins and steps/mm.
	trace: { axis: "x" | "y" | "z"; step: { port: string; pin: number }; dir: { port: string; pin: number } | null; stepsPerMm: number }[]
}

// The program the scenario runs last, after every check, for the toolpath picture: a 6 x 3 mm rectangle and its diagonal
// at 1 mm deep, from where the machine stands (G92 makes it 0,0,0), at the machine's max rate (grblHAL caps a faster F):
// small, so the whole scenario stays under about a minute.
export const TOOLPATH_PROGRAM = ["G21 G90 G92 X0 Y0 Z0", "G1 Z-1 F600", "G1 X6 F3000", "G1 Y3", "G1 X0", "G1 Y0", "G1 X6 Y3", "G1 Z0 F600"] as const

const pp = (s: ContractSnapshot, signal: string): { port: string; pin: number } | null => {
	const p = (s.values.pins ?? []).find((x) => x.signal === signal)
	const m = p ? /^P([A-H])(\d+)$/.exec(mcuPinName(s.values.parts ?? [], p.gpio)) : null
	return m ? { port: m[1], pin: Number(m[2]) } : null
}

// The scenario's numbers from the contract and the settings: each motor's expected steps for MOVE_MM, the stall's ADC
// counts (a motor current over the stall trip at half duty, through the INA180's gain and shunt).
export const MOVE_MM = { x: 2, y: 1, z: 0.5 }
export function cncSimPlan(s: ContractSnapshot, stepsPerMm: number[], stall: { thresholdA: number; gainVV: number; shuntOhm: number } | null): CncSimPlan {
	// Each motor of the machine (X, Y or Y1 and Y2, Z): a ganged axis's second motor is grblHAL's M3.
	const motors = (s.values.cnc ? motorLabels(s.values.cnc) : ["X", "Y1", "Y2", "Z"])
		.map((l) => {
			const axis = l[0].toLowerCase() as "x" | "y" | "z"
			return [/^[XYZ]2$/.test(l) ? `${l} (M3)` : l[0], `${l}_STEP`, MOVE_MM[axis] * stepsPerMm["xyz".indexOf(axis)]]
		})
		.flatMap(([name, sig, steps]) => {
		const p = pp(s, sig as string)
		return p ? [{ name: name as string, ...p, steps: Math.round(steps as number) }] : []
	})
	// Half duty (S at half the max rpm), a current 10 % over the trip: the shunt's average is that times the duty.
	const counts = stall ? Math.round(((stall.thresholdA * 1.1 * 0.5 * stall.gainVV * stall.shuntOhm) / 3.3) * 4095) : 0
	const labels = s.values.cnc ? motorLabels(s.values.cnc) : ["X", "Y1", "Y2", "Z"]
	const trace = (["x", "y", "z"] as const).flatMap((axis) => {
		const label = labels.find((l) => l[0].toLowerCase() === axis)
		const step = label ? pp(s, `${label}_STEP`) : null
		return label && step ? [{ axis, step, dir: pp(s, `${label}_DIR`), stepsPerMm: stepsPerMm["xyz".indexOf(axis)] }] : []
	})
	return { motors, move: `G21 G91 G1 X${MOVE_MM.x} Y${MOVE_MM.y} Z-${MOVE_MM.z} F600`, limitPin: pp(s, "LIMIT_X"), estopPin: pp(s, "ESTOP_TRIP"), stallCounts: counts, trace }
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
	const trace = o.plan.trace ?? []
	const ports = [...new Set([...o.plan.motors.map((m) => m.port), ...trace.flatMap((t) => (t.dir ? [t.dir.port] : []))])]
	// Each port's hook. The step counts as their checks were proven: rising edges of ODR writes against the state the
	// hook kept. The toolpath's pulse count (b.tc, per axis, while b.rec is on) reads the port's real ODR instead: grblHAL
	// also changes pins in ways no write hook sees (a lone Z move: its STEP set by ODR writes and cleared unseen). Per
	// write: S the register now, N after this write, P after the port's previous write; a STEP rise between writes (P to
	// S) or at this one (S to N) is one pulse. Directions aren't read from the DIR pins: in Renode 1.17's GPIO model they
	// never show in the register (X's and Y's on PA1 and PA4 stayed low through every move), so the path's shape comes from
	// grblHAL's own status reports, and these pulse counts check its length. IronPython 2, one line, no exceptions (the
	// monitor hangs on one).
	const count = (port: string) => {
		const bits = o.plan.motors.filter((m) => m.port === port).map((m) => m.pin)
		const traced = trace.filter((t) => t.step.port === port).map((t) => `(${t.step.pin}, '${t.axis}')`)
		const counting = `c = b.__dict__.setdefault('steps${port}', {}); o = b.__dict__.setdefault('odr', {}); p = o.get('${port}', 0); n = value if offset == 0x14 else ((p | (value & 0xFFFF)) & ~(value >> 16)) if offset == 0x18 else p; e = offset == 0x14; [c.__setitem__(k, c.get(k, 0) + 1) for k in ${JSON.stringify(bits)} if e and (n >> k) & 1 and not (p >> k) & 1]; o['${port}'] = n`
		const recording = traced.length
			? `; r = b.__dict__.get('rec'); S = self.ReadDoubleWord(0x14) if r else 0; P = b.__dict__.setdefault('pp', {}).get('${port}', S); N = ((value if value > 0xFF else (S & ~0xFF) | value) if offset == 0x14 else ((S & ~0xFF00) | ((value & 0xFF) << 8)) if offset == 0x15 else ((S | (value & 0xFFFF)) & ~(value >> 16)) if offset == 0x18 else S); t = b.__dict__.setdefault('tc', {}); [t.__setitem__(a, t.get(a, 0) + 1) for (k, a) in [${traced.join(", ")}] if r and ((not (P >> k) & 1 and (S >> k) & 1) or (not (S >> k) & 1 and (N >> k) & 1))]; b.pp['${port}'] = N`
			: ""
		return `sysbus SetHookBeforePeripheralWrite sysbus.gpioPort${port} "import __builtin__ as b; ${counting}${recording}"`
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
		// The toolpath, last, after every check: the limit released, the alarm cleared, the program recorded step by step.
		...(trace.length
			? [
					...pin(o.plan.limitPin, false),
					"sysbus.usart1 WriteChar 0x18",
					'emulation RunFor "0.5"',
					...send("$X", "0.1"),
					`python "import __builtin__ as b; b.rec = True"`,
					...TOOLPATH_PROGRAM.flatMap((l) => send(l, "0.01")),
					// grblHAL's position every 40 ms of machine time while the program runs (its status reports, in uart.txt): 2 s,
					// which the program needs about 1.5 of.
					...Array.from({ length: TOOLPATH_POLLS }, () => send("?", "0.04")).flat(),
					`python "import __builtin__ as b; b.rec = False; print('TOOLPATH PULSES', b.__dict__.get('tc', {}))"`,
				]
			: []),
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

// The toolpath: grblHAL's reported positions while the program ran (the status reports after the last reset's banner),
// from where it started, and each axis's STEP pulses counted at the pins against the distance those positions cover.
export const TOOLPATH_POLLS = 50
export interface Toolpath {
	points: [number, number, number][]
	originMm: [number, number, number] // the machine position the program started from (its G92 origin)
	finished: boolean // the last report Idle: the program ran to its end in the time given
	pulses: Record<string, number> // per axis, at the STEP pin
	travelMm: Record<string, number> // per axis, the distance the reported path covers
	pulseCheck: { axis: string; ok: boolean; detail: string }[]
}
export function toolpathFrom(uart: string, renodeOut: string, plan: CncSimPlan): Toolpath | null {
	const banner = uart.lastIndexOf("GrblHAL 1.1f")
	const reports = [...uart.slice(Math.max(0, banner)).matchAll(/<(\w+)\|MPos:(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)/g)]
	if (banner < 0 || reports.length < 2 || !plan.trace?.length) return null
	const at = reports.map((m) => [Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number])
	const o = at[0]
	const points = at.map((p) => p.map((v, i) => +(v - o[i]).toFixed(3)) as [number, number, number]).filter((p, i, a) => i === 0 || p.some((v, k) => v !== a[i - 1][k]))
	const travelMm: Record<string, number> = {}
	;(["x", "y", "z"] as const).forEach((axis, i) => (travelMm[axis] = +points.reduce((d, p, k) => (k ? d + Math.abs(p[i] - points[k - 1][i]) : 0), 0).toFixed(3)))
	const m = /TOOLPATH PULSES', \{([^}]*)\}/.exec(renodeOut) ?? /TOOLPATH PULSES \{([^}]*)\}/.exec(renodeOut)
	const pulses: Record<string, number> = {}
	for (const kv of (m?.[1] ?? "").matchAll(/'([xyz])': (\d+)L?/g)) pulses[kv[1]] = Number(kv[2])
	// One step is 1/stepsPerMm: the counted pulses and the reported travel agree to within a step per reversal or so.
	const pulseCheck = plan.trace.map((t) => {
		const want = travelMm[t.axis] * t.stepsPerMm
		const got = pulses[t.axis] ?? 0
		const ok = Math.abs(got - want) <= Math.max(4, want * 0.01)
		return { axis: t.axis, ok, detail: `${got} STEP pulses = ${(got / (t.stepsPerMm || 1)).toFixed(2)} mm at ${t.stepsPerMm}/mm; grblHAL reported ${travelMm[t.axis]} mm` }
	})
	return { points, originMm: o, finished: /^Idle$/i.test(reports[reports.length - 1][1]), pulses, travelMm, pulseCheck }
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
	// The toolpath for get_pictures (py/cnc_pictures.py), with the work area it ran on.
	const path = toolpathFrom(readFileSync(uart, "utf8"), out, plan)
	if (path) writeFileSync(join(dir, "toolpath.json"), JSON.stringify({ program: TOOLPATH_PROGRAM, ...path, workAreaMm: Object.fromEntries((s.values.cnc?.axes ?? []).map((a) => [a.name, a.travelMm])), footprintMm: s.values.cnc?.frame.footprintMm ?? null }))
	return res
}
