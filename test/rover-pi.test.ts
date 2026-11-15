// The Rover with a Pi (briefs/rover-pi.md, briefs/systems/rover-pi.json) and the scripted agents that build it: the
// brief's size and mass, the compute rover's mechanics (2S pack, 5 V regulator, 12 V motors, laid out by the solver),
// and the scripted HAT read back from its carrier brief.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { carriesCompute, computeRoverMechanics, COMPUTE_ROVER_MOTOR, COMPUTE_ROVER_PACK, COMPUTE_ROVER_REGULATOR, hatDesign, hatFromBrief, HAT_HEADER_MPN, motionFromBrief, ROVER_MOTION } from "../src/inference/scripts.ts"
import { carrierBrief } from "../src/system/carrier.ts"
import { field, moduleById, moduleHoles, moduleOutline } from "../src/system/bought.ts"
import { headerSignals, railNeed } from "../src/system/compute.ts"
import { specErrors, type SystemSpec } from "../src/system/spec.ts"
import { assemblyErrors, assemblyFitError } from "../src/system/assembly.ts"
import { byMpn } from "../src/mechanics/catalog.ts"
import { defaultCheckCatalog, mechanicsChecksWith } from "../src/mechanics/checks.ts"
import { plateLimitForBrief } from "../src/dashboard/assembly-geom.js"
import { fixtureContract } from "./fixture.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

const ROOT = resolve(import.meta.dirname, "..")
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8")
const spec = JSON.parse(read("briefs/systems/rover-pi.json")) as SystemSpec
const pi = moduleById("rpi-5")!
const cat = defaultCheckCatalog()!
const pack = byMpn(cat.mech.batteries, COMPUTE_ROVER_PACK)!

test("the brief's size and mass become the motion targets; the rest stays the reference rover's", () => {
	assert.deepEqual(motionFromBrief(read("briefs/rover.md")), ROVER_MOTION, "the reference rover's own brief gives its motion")
	const m = motionFromBrief(read("briefs/rover-pi.md"))
	assert.deepEqual(m.maxSizeMm, [260, 140])
	assert.equal(m.maxMassG, 1000)
	assert.equal(m.speedMps, ROVER_MOTION!.speedMps)
})

test("rover-pi.json: main, the bought Pi 5 and its generated HAT, valid, and the plate fits the brief with the wheels beside it", () => {
	assert.deepEqual(specErrors(spec), [])
	assert.deepEqual(assemblyErrors(spec), [])
	assert.deepEqual(spec.boards.map((b) => [b.name, b.kind ?? null, b.carries ?? null]), [["main", null, null], ["brain", "bought", null], ["rpi-5-carrier", null, "brain"]])
	assert.equal(spec.assembly?.body, "chassis")
	// The brief's outer size less two of the reference rover's wheels and their clearance holds every board.
	const wheel = byMpn(cat.mech.wheels, "POLOLU-1430")!
	const limit = plateLimitForBrief(motionFromBrief(read("briefs/rover-pi.md")).maxSizeMm, wheel.widthMm) as [number, number]
	assert.equal(assemblyFitError(spec.assembly!, limit), null)
	assert.ok(spec.assembly!.plate!.lengthMm <= limit[0] && spec.assembly!.plate!.widthMm <= limit[1])
	// The old rover brief can't take it (the 15 Nov run: a 246 mm plate against 150 mm).
	assert.match(assemblyFitError(spec.assembly!, plateLimitForBrief([150, 120], wheel.widthMm) as [number, number]) ?? "", /over the/)
})

test("the checked-in carrier brief is the one carrierBrief writes for the Pi on the 2S pack", () => {
	const carrier = spec.boards.find((b) => b.carries)!
	assert.equal(read(resolve("briefs/systems", carrier.brief!)), carrierBrief(pi, { board: "brain", battery: pack, mcuBoard: "main" }))
})

test("the scripted HAT honours the carrier brief: the module's outline and holes, the header at the record's place, 5 V into the 5V pins", () => {
	const h = hatFromBrief(read("briefs/rpi-5-carrier.md"))!
	const o = moduleOutline(pi)!
	assert.deepEqual(h.outline, { widthMm: o.widthMm, heightMm: o.heightMm })
	assert.deepEqual(h.holes, moduleHoles(pi))
	const at = field<{ x: number; y: number }>(pi, "header.at")!.value!
	assert.deepEqual(h.header, { xMm: at.x, yMm: at.y })
	const pins = (fn: string) => headerSignals(pi, "usb").filter((s) => s.fn === fn).map((s) => s.pin)
	assert.deepEqual(h.supply.pins, pins("5V"))
	assert.deepEqual(h.supply.ground, pins("GND"))
	assert.equal(h.supply.amps, railNeed(pi)!.amps)
	const d = hatDesign(h)
	assert.deepEqual([d.outline.widthMm, d.outline.heightMm, d.outline.sizeReason.kind], [85, 56, "standard-fit"])
	assert.deepEqual(d.outline.holes.map((x) => [x.x, x.y, x.dia]), [[3.5, 3.5, 2.7], [61.5, 3.5, 2.7], [3.5, 52.5, 2.7], [61.5, 52.5, 2.7]])
	const j = d.parts.find((p) => p.mpn === HAT_HEADER_MPN)!
	assert.deepEqual(j.at, { xMm: 32.5, yMm: 52.5 })
	assert.equal(j.pins.length, 40)
	assert.deepEqual(d.supplyPins.pins, [2, 4])
	assert.deepEqual(d.rails, [{ name: "5V", voltageV: 5.1, regulatorMaxMa: 5000, loadMa: 5000 }])
	assert.ok(!d.parts.some((p) => p.role === "mcu"))
	// Not a carrier brief: no HAT.
	assert.equal(hatFromBrief(read("briefs/rover.md")), null)
})

test("another module's carrier brief gives its own HAT (nothing is the Pi 5's)", () => {
	const other = ["rpi-zero-2w"].map((id) => moduleById(id)).find((m) => m && moduleOutline(m) && JSON.stringify(moduleOutline(m)) !== JSON.stringify(moduleOutline(pi)) && field(m, "header.at")?.value && railNeed(m))
	assert.ok(other, "another compute module with an outline, a header place and a peak current")
	assert.notDeepEqual(moduleOutline(other!), moduleOutline(pi))
	const h = hatFromBrief(carrierBrief(other!, { board: "brain" }))!
	assert.deepEqual(h.outline, { widthMm: moduleOutline(other!)!.widthMm, heightMm: moduleOutline(other!)!.heightMm })
	// Positions only: the Zero 2 W's record gives no hole diameter (the brief then says Ø0, a carrierBrief gap).
	assert.deepEqual(h.holes.map((x) => [x.x, x.y]), moduleHoles(other!).map((x) => [x.x, x.y]))
})

test("the compute rover's mechanics: the catalog's 2S pack, regulator and 12 V motor, the pack laid out beside the boards", () => {
	const c = fixtureContract() as ContractSnapshot
	c.values.motion = motionFromBrief(read("briefs/rover-pi.md"))
	c.values.outline = { widthMm: 43, heightMm: 28, thicknessMm: 1.6 }
	c.values.assembly = { ...spec.assembly!, self: "main" }
	assert.equal(carriesCompute(c.values.assembly), true)
	assert.equal(carriesCompute({ body: "chassis", self: "main", boards: [{ name: "main", xMm: 0, yMm: 0, rotDeg: 0, outline: { widthMm: 40, heightMm: 30 }, outlineSource: "estimate" }] }), false)
	const m = computeRoverMechanics(c)!
	assert.equal(m.battery.pack, pack.mpn)
	assert.equal(m.regulator, byMpn(cat.mech.regulators ?? [], COMPUTE_ROVER_REGULATOR)!.mpn)
	assert.equal(m.drive.motor, byMpn(cat.mech.motors, COMPUTE_ROVER_MOTOR)!.mpn)
	assert.deepEqual(m.chassis.plateMm, [spec.assembly!.plate!.lengthMm, spec.assembly!.plate!.widthMm])
	const left = mechanicsChecksWith({ ...c, values: { ...c.values, mechanics: m } }, cat).filter((v) => v.kind !== "mech-wiring")
	assert.ok(!left.some((v) => /battery doesn't fit under boards/.test(v.message)), "the pack is beside the boards")
	assert.deepEqual(left.map((v) => v.message), [])
})

test("the HAT board drills the module's own holes (its outline's), not the generic M2 corners", async () => {
	const { mountingHoles } = await import("../src/codegen/circuit.ts")
	const d = hatDesign(hatFromBrief(read("briefs/rpi-5-carrier.md"))!)
	const c = fixtureContract() as ContractSnapshot
	c.values.outline = d.outline
	c.values.parts = d.parts
	c.values.connectors = []
	assert.deepEqual(mountingHoles(c).map((h) => [h.x, h.y, h.diameterMm]), [[-39, -24.5, 2.7], [19, -24.5, 2.7], [-39, 24.5, 2.7], [19, 24.5, 2.7]])
})

// Premerge review (15 Nov): a record without hole diameters wrote "Ø0 mm" into the carrier brief, read back as a 0 mm
// hole that codegen drilled (h.dia ?? default lets 0 through). The brief now says the diameter is unknown and which
// default is drilled; codegen refuses a non-positive diameter.
test("a module record without hole diameters: the carrier brief says unknown, the HAT drills the stated default, never a 0 mm hole", async () => {
	const { mountingHoles, MOUNTING_HOLE } = await import("../src/codegen/circuit.ts")
	const m = structuredClone(pi)
	for (const h of (m.compute as { holes: { value: { dia: number | null }[] } }).holes.value) h.dia = null
	const b = carrierBrief(m, { board: "brain", battery: pack, mcuBoard: "main" })
	assert.doesNotMatch(b, /Ø0 mm/)
	assert.match(b, /4 mounting holes of unknown diameter \(the module record doesn't give it: the board's default Ø2\.2 mm hole is drilled until it is measured\)/)
	const h = hatFromBrief(b)!
	assert.deepEqual(h.holes.map((x) => x.dia), [null, null, null, null])
	const d = hatDesign(h)
	const s = { revision: 1, versions: {} as never, values: { outline: d.outline } } as ContractSnapshot
	assert.deepEqual(mountingHoles(s).map((x) => x.diameterMm), [2.2, 2.2, 2.2, 2.2].map(() => MOUNTING_HOLE.diameterMm))
	s.values.outline!.holes![1] = { ...s.values.outline!.holes![1], dia: 0 }
	assert.throws(() => mountingHoles(s), /outline\.holes\[1\] .* has diameter 0 mm: a mounting hole needs a positive diameter/)
})

// Premerge review (15 Nov): a carrier brief missing a value (an unknown peak current, no holes, "?" pins) made
// hatFromBrief return null, and the architect silently designed the generic ESP32 logger instead of the carrier.
test("a carrier brief missing a value the HAT needs fails loudly, naming it, instead of becoming the generic logger", () => {
	const noPeak = structuredClone(pi)
	delete (noPeak.compute as { currentA: { peak?: unknown } }).currentA.peak
	const b = carrierBrief(noPeak, { board: "brain", battery: pack, mcuBoard: "main" })
	assert.throws(() => hatFromBrief(b), /the carrier brief for the Raspberry Pi 5 lacks the 5 V supply's current and header pins/)
	const noHoles = structuredClone(pi)
	;(noHoles.compute as { holes: { value: unknown[] } }).holes.value = []
	assert.throws(() => hatFromBrief(carrierBrief(noHoles, { board: "brain", battery: pack })), /lacks the module's outline and mounting holes/)
	const ok = carrierBrief(pi, { board: "brain", battery: pack })
	assert.throws(() => hatFromBrief(ok.replace(/into header pins 2 and 4/, "into header pins ?")), /lacks the 5 V supply's current and header pins/)
	assert.equal(hatFromBrief(read("briefs/rover.md")), null, "not a carrier brief: no HAT, no error")
})

// Premerge review (15 Nov): on every consistency wake where the pack wasn't the 2S, the scripted mechanics engineer
// re-proposed the 2S layout, reverting an engineer's change request for another pack.
test("the scripted mechanics engineer picks the 2S compute layout once, and keeps a pack a change request chose", async () => {
	const { picksComputeMechanics, ROVER_MECHANICS } = await import("../src/inference/scripts.ts")
	assert.equal(picksComputeMechanics(undefined, false), true, "no mechanics yet: the compute rover")
	assert.equal(picksComputeMechanics(ROVER_MECHANICS, false), true, "the reference rover chosen before the system's body arrived")
	const other = { ...ROVER_MECHANICS!, battery: { ...ROVER_MECHANICS!.battery, pack: "ADAFRUIT-258 LP-503562 1200 mAh" } }
	assert.equal(picksComputeMechanics(other, false), false, "a pack someone chose")
	assert.equal(picksComputeMechanics(ROVER_MECHANICS, true), false, "after the 2S layout reached the contract, even the reference pack is a choice")
})
