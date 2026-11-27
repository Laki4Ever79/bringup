// The CNC's firmware-in-the-loop scenario (src/tools/cnc-sim.ts), its pure parts: the plan from the contract (each motor's
// steps for the move, the stall's ADC counts), the Renode script (the TIM5 reload hook, the step counters, our settings),
// and the judgement of a run's output. A Renode run itself: scratch runs on 27 Nov 2026 gave X 800, Y 400, M3 400, Z 200
// steps exactly and ALARM:14 from the stall plugin; the e-stop's and limit's inputs don't reach grblHAL yet (open).
import { test } from "node:test"
import assert from "node:assert/strict"
import { CNC_DESIGN, CNC_MACHINE, CNC_TARGETS } from "../src/inference/scripts.ts"
import { cncSimPlan, cncSimScript, judgeCncSim, CNC_SIM_LIMITS } from "../src/tools/cnc-sim.ts"
import { stallParams } from "../src/cnc/stall.ts"
import { defaultCheckCatalog } from "../src/mechanics/checks.ts"
import { fixtureContract } from "./fixture.ts"

const cnc = () => {
	const b = fixtureContract()
	return { ...b, values: { ...b.values, ...CNC_DESIGN, cncTargets: CNC_TARGETS, cnc: CNC_MACHINE } } as typeof b
}

test("the scenario's plan: every motor's steps for X2 Y1 Z-0.5 at 400 steps/mm, Y's second motor (M3) like Y; the stall's ADC counts", () => {
	const s = cnc()
	const plan = cncSimPlan(s, [400, 400, 400], stallParams(s, defaultCheckCatalog()!))
	assert.deepEqual(plan.motors.map((m) => `${m.name} P${m.port}${m.pin} ${m.steps}`), ["X PA0 800", "Y PA3 400", "Y2 (M3) PA6 400", "Z PB1 200"])
	// 6.0 A × 1.1 over the trip, at half duty, through 20 V/V on 10 mOhm: 0.66 V = 819 counts of 4095 at 3.3 V.
	assert.equal(plan.stallCounts, 819)
	assert.deepEqual(plan.estopPin, { port: "B", pin: 12 })
	const script = cncSimScript({ repl: "/r.repl", elf: "/f.elf", uart: "/u.txt", settings: ["$22=1", "$100=400"], plan })
	for (const x of ['logLevel 3', 'SetHookBeforePeripheralWrite sysbus.timer5', 'SetHookBeforePeripheralWrite sysbus.gpioPortA', 'SetHookBeforePeripheralWrite sysbus.gpioPortB', 'sysbus.usart1 WriteLine "$22=1"', `sysbus WriteDoubleWord 0x400123FC 819`, 'sysbus.gpioPortB OnGPIO 12 true', 'sysbus.exti OnGPIO 12 true', 'sysbus.gpioPortB OnGPIO 13 true', 'sysbus.exti OnGPIO 13 true'])
		assert.ok(script.includes(x), x)
	assert.ok(!script.includes("\\$"), "no shell-style escapes: Renode passes them through")
})

test("a run's judgement: exact steps per motor, the alarms by their codes, the known limits always carried", () => {
	const plan = cncSimPlan(cnc(), [400, 400, 400], stallParams(cnc(), defaultCheckCatalog()!))
	const out = "('STEPS A', {0: 800, 3: 400, 6: 400})\n('STEPS B', {1L: 200})"
	const pass = judgeCncSim("ALARM:10\n<Alarm|MPos:0,0,0>\nGrblHAL 1.1f\nALARM:14\nALARM:1\n", out, plan)
	assert.equal(pass.result, "pass", JSON.stringify(pass.checks))
	assert.deepEqual(pass.knownLimits, CNC_SIM_LIMITS)
	const miss = judgeCncSim("ALARM:14\n", "('STEPS A', {0: 799, 3: 400, 6: 0})\n('STEPS B', {1: 200})", plan)
	assert.deepEqual(miss.checks.filter((c) => !c.ok).map((c) => c.name), ["X steps", "Y2 (M3) steps", "e-stop", "hard limit"])
})

test("the toolpath: a program after every check, grblHAL's reported positions from where it started, its STEP pulses at the pins against them", async () => {
	const { toolpathFrom, TOOLPATH_PROGRAM } = await import("../src/tools/cnc-sim.ts")
	const s = cnc()
	const plan = cncSimPlan(s, [400, 400, 400], stallParams(s, defaultCheckCatalog()!))
	assert.deepEqual(plan.trace.map((t) => `${t.axis} P${t.step.port}${t.step.pin}${t.dir ? ` P${t.dir.port}${t.dir.pin}` : ""}`).length, 3)
	const script = cncSimScript({ repl: "/r.repl", elf: "/f.elf", uart: "/u.txt", settings: ["$22=1"], plan })
	// The checks keep their place: the program comes after the hard limit's status query.
	assert.ok(script.indexOf("b.rec = True") > script.lastIndexOf("sysbus.exti OnGPIO 13 true"))
	for (const l of TOOLPATH_PROGRAM) assert.ok(script.includes(`WriteLine "${l}"`), l)
	assert.ok(script.includes("print('TOOLPATH PULSES'"))
	// grblHAL's status reports after the last reset's banner, from where it started; the pins' pulses against them.
	const uart = "ALARM:1\n<Alarm|MPos:9,9,9|Bf:1>\nGrblHAL 1.1f ['$' or '$HELP' for help]\nok\n" + [[2, 1, -0.5], [2, 1, -1.5], [8, 1, -1.5], [8, 4, -1.5], [2, 4, -1.5], [2, 1, -1.5], [8, 4, -1.5], [8, 4, -0.5]].map((p, i, a) => `<${i === a.length - 1 ? "Idle" : "Run"}|MPos:${p.join(",")}|FS:0,0>\nok\n`).join("")
	const p = toolpathFrom(uart, "('TOOLPATH PULSES', {'x': 7200, 'y': 3600L, 'z': 800})", plan)!
	assert.deepEqual(p.originMm, [2, 1, -0.5])
	assert.deepEqual(p.points[0], [0, 0, 0])
	assert.deepEqual(p.points.at(-1), [6, 3, 0])
	assert.equal(p.finished, true)
	assert.deepEqual(p.travelMm, { x: 18, y: 9, z: 2 })
	assert.deepEqual(p.pulseCheck.map((c) => c.ok), [true, true, true])
	assert.deepEqual(toolpathFrom(uart, "('TOOLPATH PULSES', {'x': 7000, 'y': 3600, 'z': 800})", plan)!.pulseCheck.map((c) => c.ok), [false, true, true])
	assert.equal(toolpathFrom("no reports", "", plan), null)
})
