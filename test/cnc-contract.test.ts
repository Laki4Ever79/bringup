// The CNC's contract fields (src/cnc, docs/cnc.md gap 1): their shapes, owners, and the rover checks staying out.
import { test } from "node:test"
import assert from "node:assert/strict"
import { cncShapeError, cncTargetsShapeError } from "../src/cnc/shape.ts"
import type { CncSpec, CncTargets } from "../src/cnc/types.ts"
import { DesignContract } from "../src/contract/contract.ts"
import { OWNERS, type ContractSnapshot } from "../src/contract/types.ts"
import { hearsRequest } from "../src/agents/roles.ts"
import { mechanicsChecks } from "../src/mechanics/checks.ts"
import { CNC_MACHINE, CNC_TARGETS as SCRIPTED_TARGETS } from "../src/inference/scripts.ts"
import { cncChecks, driverRmsA, pulloutAt } from "../src/cnc/checks.ts"
import { defaultCheckCatalog } from "../src/mechanics/checks.ts"

// briefs/cnc.md's targets and the machine meeting them: the mock's scripted answer (src/inference/scripts.ts).
export const CNC_TARGETS: CncTargets = SCRIPTED_TARGETS
export const CNC: CncSpec = CNC_MACHINE
const screw = (mm: number) => `GOBILDA-3501-0804-0${mm} lead screw 8 mm lead ${mm} mm`

test("cnc shapes: the fixture machine passes; wrong axes, shared UART addresses and bad microsteps fail by name", () => {
	assert.equal(cncTargetsShapeError(CNC_TARGETS), null)
	assert.ok(cncTargetsShapeError({ ...CNC_TARGETS, travelMm: { x: 300, y: 200 } }))
	assert.ok(cncTargetsShapeError({ ...CNC_TARGETS, spindleW: 0 }))
	assert.equal(cncShapeError(CNC), null)
	assert.match(cncShapeError({ ...CNC, axes: [CNC.axes[1], CNC.axes[0], CNC.axes[2]] }) ?? "", /axes are y, x, z/)
	assert.match(cncShapeError({ ...CNC, axes: CNC.axes.map((a) => ({ ...a, driver: { ...a.driver, uartAddr: 0 } })) }) ?? "", /share a UART address/)
	assert.match(cncShapeError({ ...CNC, axes: CNC.axes.map((a, i) => (i === 2 ? { ...a, driver: { ...a.driver, microsteps: 12 } } : a)) }) ?? "", /axis z is wrong/)
	assert.match(cncShapeError({ ...CNC, firmware: "marlin" }) ?? "", /firmware/)
})

test("the contract takes cncTargets from the architect and cnc from the mechanics agent, through their shapes", () => {
	assert.equal(OWNERS.cncTargets, "architect")
	assert.equal(OWNERS.cnc, "mechanics")
	const c = new DesignContract()
	assert.equal(c.propose({ field: "cncTargets", value: CNC_TARGETS, by: "architect", baseVersion: 0 }).status, "applied")
	assert.equal(c.propose({ field: "cnc", value: CNC, by: "mechanics", baseVersion: 0 }).status, "applied")
	assert.equal(c.propose({ field: "cnc", value: CNC, by: "architect", baseVersion: 1 }).status, "not-owner")
	assert.equal(c.propose({ field: "cnc", value: { ...CNC, axes: CNC.axes.slice(0, 2) }, by: "mechanics", baseVersion: 1 }).status, "invalid")
	// The mechanics agent hears change requests on a CNC ("make the Z travel 80 mm").
	assert.equal(hearsRequest("mechanics", (f) => f === "cncTargets", "make the Z travel 80 mm"), true)
})

test("a CNC's requirements name motors, yet the rover's checks stay out of it", () => {
	const snap = (values: ContractSnapshot["values"]): ContractSnapshot => ({ revision: 1, values, versions: {} as ContractSnapshot["versions"] })
	const cnc = { summary: "a desktop CNC router on three stepper motors", peripherals: ["three stepper motors", "spindle"], batteryLifeDays: null }
	assert.deepEqual(mechanicsChecks(snap({ requirements: cnc, cncTargets: CNC_TARGETS, cnc: CNC })), [], "the fixture machine meets its brief")
	// Its own checks instead: a short axis, a frame too big for the desk, a spindle off the brick's volts.
	const short = { ...CNC, axes: CNC.axes.map((a) => (a.name === "x" ? { ...a, travelMm: 250 } : a)), frame: { ...CNC.frame, footprintMm: [500, 350] as [number, number] }, spindle: { ...CNC.spindle, volts: 48 } }
	const got = mechanicsChecks(snap({ requirements: cnc, cncTargets: CNC_TARGETS, cnc: short }))
	assert.deepEqual(got.map((v) => v.kind).sort(), ["cnc-supply", "cnc-supply", "cnc-travel", "cnc-travel"], "the 48 V spindle: off the brick and off its catalog entry")
	assert.match(got.find((v) => /X axis/.test(v.message))!.message, /250 mm, short of the brief's 300 mm/)
	// Without its fields: the architect is asked for cncTargets, not a rover's motion (it was, before 26 Nov).
	const [v] = mechanicsChecks(snap({ requirements: cnc }))
	assert.deepEqual(v.fields, ["cncTargets"])
	assert.deepEqual(v.affects, ["architect"])
})

test("cnc checks with the catalog: the fixture passes; each axis's screw, current, step and torque, and the brick, fail by name", () => {
	const cat = defaultCheckCatalog()!
	const run = (cnc: CncSpec, t: CncTargets = CNC_TARGETS) => cncChecks({ cncTargets: t, cnc }, cat)
	assert.deepEqual(run(CNC), [])
	const on = (name: string, f: (a: CncSpec["axes"][number]) => CncSpec["axes"][number]) => ({ ...CNC, axes: CNC.axes.map((a) => (a.name === name ? f(a) : a)) })
	// A part that isn't in the catalog stops the rest (no numbers to check against).
	assert.match(run(on("x", (a) => ({ ...a, motor: "17HS4401" })))[0].message, /the X motor 17HS4401 \(steppers: 17HS15-1504S1\)/)
	// The X screw of 300 mm can't give 300 mm of travel plus the nut and bearings.
	assert.match(run(on("x", (a) => ({ ...a, screw: screw(300) })))[0].message, /X screw is 300 mm, short of the 300 mm travel plus 40 mm/)
	// 1.6 A: over the motor's 1.5 A and the TMC2209's 1.4 A.
	assert.deepEqual(run(on("y", (a) => ({ ...a, driver: { ...a.driver, currentA: 1.6 } }))).map((v) => v.message.match(/over the ([^ ]+)/)?.[1]), ["17HS15-1504S1's", "TMC2209-LA's"])
	assert.deepEqual(driverRmsA({}, cat), { mpn: "TMC2209-LA", contA: 1.4 }, "the catalog's number (datasheet §20.1)")
	// A 0.02 mm repeatability: one 1.8° step of an 8 mm lead is 0.040 mm.
	assert.match(run(CNC, { ...CNC_TARGETS, repeatMm: 0.02 })[0].message, /one full step moves the X axis 0\.040 mm/)
	// A 9600 mm/min rapid is 1200 rpm on the 8 mm lead, where the motor pulls 0.10 N·m: Z's lift (spindle carriage,
	// gravity, the cut, ×2) needs 0.107 N·m and fails; X and Y, with no gravity, pass. At 9000 (1125 rpm, 0.119) Z passes.
	const fast = run(CNC, { ...CNC_TARGETS, rapidMmMin: 9600 })
	assert.deepEqual(fast.map((v) => v.message.match(/the ([XYZ]) motor/)?.[1]), ["Z"], fast.map((v) => v.message).join("\n"))
	assert.match(fast[0].message, /at the 9600 mm\/min rapid \(1200 rpm\) the Z motor pulls 0\.100 N·m at 1\.2 A, short of the 0\.107 N·m/)
	assert.deepEqual(run(CNC, { ...CNC_TARGETS, rapidMmMin: 9000 }), [])
	assert.ok(Math.abs(pulloutAt(cat.mech.steppers![0], 450) - 0.325) < 1e-9, "linear between 300 and 600 rpm")
	// A brick the catalog doesn't have (48 V): a parts finding.
	assert.match(run({ ...CNC, input: { ...CNC.input, volts: 48 } }).find((v) => v.kind === "cnc-parts")?.message ?? "", /a 48 V brick of at least 6\.67 A \(powerBricks: 12 V 5 A, 12 V 5 A, 24 V 6\.67 A\)/)
	// A 3 A brick: 72 W for ~133 W of motors, spindle and logic.
	assert.match(run({ ...CNC, input: { ...CNC.input, amps: 3 } })[0].message, /gives 72 W; .* need 133 W/)
})

test("cnc checks: targets with no machine wake the mechanics agent; a board short of stepper drivers wakes the parts agent; unwired drivers wake the architect", async () => {
	const [fit] = cncChecks({ cncTargets: CNC_TARGETS })
	assert.equal(fit.kind, "cnc-fit")
	assert.deepEqual(fit.affects, ["mechanics"])
	const [w] = cncChecks({ cncTargets: CNC_TARGETS, cnc: CNC, parts: [] })
	assert.equal(w.kind, "cnc-wiring")
	assert.match(w.message, /4 stepper motors \(X, Y ×2, Z\) but the board has 0 stepper drivers/)
	assert.deepEqual(w.affects, ["parts"])
	// Drivers on the board but driven by nothing (CNC mock run 6 settled like this): their STEP/DIR/ENN and a 24 V rail.
	const { CNC_DESIGN } = await import("../src/inference/scripts.ts")
	const unwired = cncChecks({ cncTargets: CNC_TARGETS, cnc: CNC, parts: CNC_DESIGN.parts, pins: [], rails: CNC_DESIGN.rails })
	assert.equal(unwired.filter((v) => /has no GPIO on STEP, DIR, ENN/.test(v.message)).length, 4)
	assert.ok(unwired.some((v) => /no 24 V rail for the stepper drivers' motor supply/.test(v.message)))
	assert.ok(unwired.every((v) => v.kind === "cnc-wiring"))
})
