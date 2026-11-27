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
	for (const x of ['logLevel 3', 'SetHookBeforePeripheralWrite sysbus.timer5', 'SetHookBeforePeripheralWrite sysbus.gpioPortA', 'SetHookBeforePeripheralWrite sysbus.gpioPortB', 'sysbus.usart1 WriteLine "$22=1"', `sysbus WriteDoubleWord 0x400123FC 819`, 'sysbus.gpioPortB OnGPIO 12 true'])
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
