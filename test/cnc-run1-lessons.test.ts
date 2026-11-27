// The first real CNC run's lessons (out/real-runs/cc-cnc-1, 27 Nov 2026, docs/cnc.md): a machine with one Y motor is
// asked for Y_STEP/Y_DIR, not the scripted gantry's Y1/Y2; the grblHAL map and the simulation follow its motors; the
// cnc-parts message lists the catalog's lead screws and rails; a UART TX wired straight onto the drivers' line is flagged.
import { test } from "node:test"
import assert from "node:assert/strict"
import { CNC_DESIGN, CNC_MACHINE, CNC_TARGETS } from "../src/inference/scripts.ts"
import { cncChecks } from "../src/cnc/checks.ts"
import { grblhalMap, grblhalPins } from "../src/cnc/grblhal.ts"
import { cncSimPlan } from "../src/tools/cnc-sim.ts"
import { cncSignals } from "../src/cnc/signals.ts"
import { defaultCheckCatalog } from "../src/mechanics/checks.ts"
import type { ContractSnapshot, ContractValues } from "../src/contract/types.ts"

const cat = defaultCheckCatalog()!
// The scripted machine with one Y motor: its Y driver's pins renamed Y_STEP/Y_DIR, the second Y driver and its pins gone.
const oneY = (): ContractValues =>
	({
		...CNC_DESIGN,
		cnc: { ...CNC_MACHINE, axes: CNC_MACHINE.axes.map((a) => (a.name === "y" ? { ...a, motors: 1 } : a)) },
		parts: CNC_DESIGN.parts!.filter((p) => p.ref !== "U6" && p.ref !== "JX3"),
		pins: CNC_DESIGN.pins!.filter((p) => !p.signal.startsWith("Y2_")).map((p) => ({ ...p, signal: p.signal.replace(/^Y1_/, "Y_") })),
	}) as ContractValues
const snap = (values: ContractValues) => ({ revision: 0, versions: {}, values }) as unknown as ContractSnapshot

test("one Y motor: the firmware's signals are Y_STEP/Y_DIR, nothing asks for Y1 or Y2, the map has no M3 and the sim moves three motors", () => {
	const v = oneY()
	assert.deepEqual(cncSignals(v.cnc).slice(0, 6), ["X_STEP", "X_DIR", "Y_STEP", "Y_DIR", "Z_STEP", "Z_DIR"])
	assert.deepEqual(grblhalPins(snap(v)).missing, [])
	assert.equal(cncChecks(v, cat).filter((x) => /Y1|Y2/.test(x.message)).length, 0)
	const map = grblhalMap(snap(v))
	assert.match(map, /#define Y_STEP_PORT GPIOA\n#define Y_STEP_PIN 3/)
	assert.doesNotMatch(map, /M3_AVAILABLE/)
	assert.deepEqual(cncSimPlan(snap(v), [400, 400, 400], null).motors.map((m) => m.name), ["X", "Y", "Z"])
	// The scripted gantry keeps its M3 on Y2.
	assert.match(grblhalMap(snap({ ...CNC_DESIGN, cnc: CNC_MACHINE } as ContractValues)), /#define M3_STEP_PORT GPIOA\n#define M3_STEP_PIN 6/)
})

test("cnc-parts lists the catalog's lead screws and rails by name", () => {
	const v = { ...CNC_DESIGN, cncTargets: CNC_TARGETS, cnc: { ...CNC_MACHINE, axes: CNC_MACHINE.axes.map((a) => ({ ...a, screw: "TR8x8", rail: "MGN12H-rail" })) } } as ContractValues
	const m = cncChecks(v, cat).find((x) => x.kind === "cnc-parts")!.message
	assert.match(m, /the X screw TR8x8 \(driveTrain lead screws: .*"GOBILDA-3501-0804-0400 lead screw 8 mm lead 400 mm"/)
	assert.match(m, /the X rail MGN12H-rail \(rails: .*"HIWIN MGN12H"/)
	assert.match(m, /Use a catalog name exactly as listed/)
})

test("STEPPER_UART_TX straight on a driver's PDN_UART is flagged, with the resistor to put between", () => {
	const v = { ...CNC_DESIGN, cnc: CNC_MACHINE, pins: CNC_DESIGN.pins!.map((p) => (p.signal === "STEPPER_UART_TX" ? { ...p, partRef: "U4", partPin: "PDN_UART" } : p)) } as ContractValues
	const m = cncChecks(v, cat).filter((x) => /goes straight onto/.test(x.message))
	assert.equal(m.length, 1)
	assert.match(m[0].message, /STEPPER_UART_TX goes straight onto U4\.PDN_UART.*0402WGF1001TCE/)
	assert.equal(cncChecks({ ...CNC_DESIGN, cnc: CNC_MACHINE } as ContractValues, cat).filter((x) => /goes straight onto/.test(x.message)).length, 0)
})

test("a motor rail rated past the brick is flagged; the scripted rail at the brick's 6.67 A is not", () => {
	const rails = CNC_DESIGN.rails!.map((r) => (r.name === "VMOT" ? { ...r, regulatorMaxMa: 10000, loadMa: 9300 } : r))
	const m = cncChecks({ ...CNC_DESIGN, rails, cnc: CNC_MACHINE } as ContractValues, cat).filter((x) => /rail is rated/.test(x.message))
	assert.equal(m.length, 1)
	assert.match(m[0].message, /the VMOT rail is rated 10000 mA, but the 24 V brick in cnc.input gives 6670 mA/)
	assert.deepEqual(m[0].affects, ["architect"])
	assert.equal(cncChecks({ ...CNC_DESIGN, cnc: CNC_MACHINE } as ContractValues, cat).filter((x) => /rail is rated/.test(x.message)).length, 0)
})
