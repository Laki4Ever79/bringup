import assert from "node:assert/strict"
import { test } from "node:test"
import { beltLengthMm, chainLinks, driveTrainChecks, pitchDiameter, type DriveTrainPart } from "../src/mechanics/drivetrain.ts"

const shaft = (id: string, d: number, extra: Partial<Extract<DriveTrainPart, { kind: "shaft" }>> = {}): DriveTrainPart => ({ id, kind: "shaft", diameterMm: d, lengthMm: 50, ...extra })
const msgs = (parts: DriveTrainPart[]) => driveTrainChecks(parts).map((v) => v.message)

test("formulas: GT2 20T pitch diameter, an open belt's length, a chain's links", () => {
	assert.ok(Math.abs(pitchDiameter({ pitchMm: 2, teeth: 20 }) - 12.732) < 0.001)
	// Equal pulleys: 2C + πD.
	assert.ok(Math.abs(beltLengthMm(12.732, 12.732, 50) - (100 + Math.PI * 12.732)) < 1e-9)
	// Equal sprockets: 2C/p + z.
	assert.ok(Math.abs(chainLinks(6.35, 10, 10, 63.5) - 30) < 1e-9)
})

test("a gear pair meshes only at the same module and the right centre distance", () => {
	const base: DriveTrainPart[] = [shaft("s1", 5), shaft("s2", 5), { id: "g1", kind: "gear", module: 1, teeth: 20, boreMm: 5, shaft: "s1" }, { id: "g2", kind: "gear", module: 1, teeth: 40, boreMm: 5, shaft: "s2" }]
	assert.deepEqual(msgs([...base, { id: "m", kind: "mesh", gears: ["g1", "g2"], centreMm: 30 }]), [])
	assert.match(msgs([...base, { id: "m", kind: "mesh", gears: ["g1", "g2"], centreMm: 30.5 }])[0], /mesh at 30 mm between centres; the design puts them 30.5 mm apart \(backlash/)
	const odd = base.map((p) => (p.id === "g2" ? { ...p, module: 1.5 } : p)) as DriveTrainPart[]
	assert.match(msgs([...odd, { id: "m", kind: "mesh", gears: ["g1", "g2"], centreMm: 30 }])[0], /can't mesh: gears mesh only at the same module/)
})

test("a belt fits its pulleys' pitch and its length sits within the tension travel", () => {
	const pulleys: DriveTrainPart[] = [shaft("motor", 5), shaft("axle", 8), { id: "p1", kind: "pulley", pitchMm: 2, teeth: 20, boreMm: 5, shaft: "motor" }, { id: "p2", kind: "pulley", pitchMm: 2, teeth: 20, boreMm: 8, shaft: "axle" }]
	// GT2 20T/20T on a 200-tooth (400 mm) belt: C = (400 - 40)/2 = 180 mm.
	const belt = (centreMm: number, extra = {}): DriveTrainPart => ({ id: "b", kind: "belt", pitchMm: 2, teeth: 200, pulleys: ["p1", "p2"], centreMm, tensionTravelMm: 3, ...extra })
	assert.deepEqual(msgs([...pulleys, belt(178)]), [])
	assert.match(msgs([...pulleys, belt(182)])[0], /2 mm too far: it won't go on/)
	assert.match(msgs([...pulleys, belt(170)])[0], /10 mm too close, past the 3 mm tension travel: it will be slack/)
	assert.match(msgs([...pulleys, belt(178, { pitchMm: 3 })])[0], /a belt runs only on pulleys of its own pitch/)
	assert.match(msgs([...pulleys, belt(178, { teeth: 10 })])[0], /too short to go round both/)
})

test("a chain: pitch, an even link count, its length within the travel", () => {
	const sp: DriveTrainPart[] = [shaft("a", 8), shaft("b", 8), { id: "s1", kind: "sprocket", pitchMm: 6.35, teeth: 10, boreMm: 8, shaft: "a" }, { id: "s2", kind: "sprocket", pitchMm: 6.35, teeth: 10, boreMm: 8, shaft: "b" }]
	assert.deepEqual(msgs([...sp, { id: "c", kind: "chain", pitchMm: 6.35, links: 30, sprockets: ["s1", "s2"], centreMm: 63, tensionTravelMm: 2 }]), [])
	assert.ok(msgs([...sp, { id: "c", kind: "chain", pitchMm: 6.35, links: 31, sprockets: ["s1", "s2"], centreMm: 66, tensionTravelMm: 2 }]).some((m) => /odd count needs an offset link/.test(m)))
})

test("hubs, bearings, couplers and lead screws fit what they sit on", () => {
	const m = msgs([
		shaft("s", 8, { rpm: 3000, radialLoadN: 500 }),
		shaft("motor", 5),
		{ id: "p", kind: "pulley", pitchMm: 2, teeth: 20, boreMm: 5, shaft: "s" },
		{ id: "brg", kind: "bearing", boreMm: 8, outerMm: 22, shaft: "s", seatMm: 21.9, ratedRpm: 2000, ratedLoadN: 1000 },
		{ id: "cpl", kind: "coupler", boresMm: [5, 6], shafts: ["motor", "s"] },
		{ id: "ls", kind: "leadscrew", diameterMm: 8, leadMm: 8, nut: "n" },
		{ id: "n", kind: "leadnut", diameterMm: 8, leadMm: 2 },
		{ id: "x", kind: "pulley", pitchMm: 2, teeth: 20, boreMm: 5, shaft: "nowhere" },
	])
	assert.ok(m.some((x) => /p \(pulley\) has a 5 mm bore on s, a 8 mm shaft: won't go on by 3 mm/.test(x)), m.join("\n"))
	assert.ok(m.some((x) => /brg's printed seat is 21.9 mm for a 22 mm outer ring \(-0.1 mm\)/.test(x)))
	assert.ok(m.some((x) => /brg is rated 2000 rpm; s turns at 3000 rpm/.test(x)))
	assert.ok(!m.some((x) => /rated 1000 N/.test(x)))
	assert.ok(m.some((x) => /cpl's second bore is 6 mm; s is 8 mm/.test(x)))
	assert.ok(m.some((x) => /a nut fits only its own screw's diameter and lead/.test(x)))
	assert.ok(m.some((x) => /mates with "nowhere", which the drive train doesn't have/.test(x)))
})

test("the contract takes a drive train, rejects a malformed one, and the robot's checks report a misfit", async () => {
	const { readFileSync } = await import("node:fs")
	const { join } = await import("node:path")
	const { mechanicsShapeError } = await import("../src/mechanics/shape.ts")
	const { mechanicsChecks } = await import("../src/mechanics/checks.ts")
	const s = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/e2e-rover2-rev11.json"), "utf8"))
	const mech = s.values.mechanics
	assert.equal(mechanicsShapeError(mech), null)
	const train: DriveTrainPart[] = [shaft("axle", 8), { id: "brg", kind: "bearing", boreMm: 6, outerMm: 19, shaft: "axle", seatMm: 19.1 }]
	assert.equal(mechanicsShapeError({ ...mech, driveTrain: train }), null)
	assert.match(mechanicsShapeError({ ...mech, driveTrain: [{ id: "g", kind: "gear", module: 1 }] }) ?? "", /g \(gear\) has a bad or missing teeth/)
	assert.match(mechanicsShapeError({ ...mech, driveTrain: [{ id: "w", kind: "widget" }] }) ?? "", /driveTrain \(optional\) must be a list/)
	const before = mechanicsChecks(s).filter((v) => v.kind === "mech-mate")
	assert.deepEqual(before, [])
	const after = mechanicsChecks({ ...s, values: { ...s.values, mechanics: { ...mech, driveTrain: train } } }).filter((v) => v.kind === "mech-mate")
	assert.equal(after.length, 1)
	assert.match(after[0].message, /brg \(bearing\) has a 6 mm bore on axle, a 8 mm shaft/)
	assert.deepEqual(after[0].affects, ["mechanics"])
})

// Drive-train step 2 (16 Nov 2026): sourced catalog entries; a part named by its mpn must carry the catalog's numbers.
test("a drive-train part named by a catalog mpn is held to the catalog's numbers", async () => {
	const { readFileSync } = await import("node:fs")
	const { join } = await import("node:path")
	const { mechanicsChecks } = await import("../src/mechanics/checks.ts")
	const s = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/e2e-rover2-rev11.json"), "utf8"))
	const mech = s.values.mechanics
	const train: DriveTrainPart[] = [shaft("motor", 5), { id: "p1", kind: "pulley", pitchMm: 2, teeth: 20, boreMm: 5, shaft: "motor", mpn: "ADAFRUIT-1251 GT2 pulley 20T 5 mm bore" }]
	const mates = (t: DriveTrainPart[]) => mechanicsChecks({ ...s, values: { ...s.values, mechanics: { ...mech, driveTrain: t } } }).filter((v) => v.kind === "mech-mate").map((v) => v.message)
	assert.deepEqual(mates(train), [])
	assert.match(mates([train[0], { ...train[1], boreMm: 6 } as DriveTrainPart]).join("\n"), /p1 \(ADAFRUIT-1251 .*\) differs from its catalog entry: boreMm 6 \(catalog 5\)/)
	assert.match(mates([train[0], { ...train[1], mpn: "NOPE-1" } as DriveTrainPart]).join("\n"), /NOPE-1 is not in catalog\/mechanics.json driveTrain/)
})

// More sourced catalog entries (16 Nov 2026): KHK module-1 spur gears 20T/40T (8 mm bore) and goBILDA's 8 mm lead screw
// with its nut. Named by mpn with the catalog's numbers, they mate: the gears at (20 + 40) / 2 = 30 mm, the nut on the screw.
test("the catalog's module-1 gears mesh at 30 mm and its lead screw takes its nut", async () => {
	const { readFileSync } = await import("node:fs")
	const { join } = await import("node:path")
	const { mechanicsChecks } = await import("../src/mechanics/checks.ts")
	const s = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/e2e-rover2-rev11.json"), "utf8"))
	const mech = s.values.mechanics
	const train: DriveTrainPart[] = [
		shaft("a", 8), shaft("b", 8),
		{ id: "g1", kind: "gear", module: 1, teeth: 20, boreMm: 8, shaft: "a", mpn: "KHK-SSA1-20J8" },
		{ id: "g2", kind: "gear", module: 1, teeth: 40, boreMm: 8, shaft: "b", mpn: "KHK-SSA1-40J8" },
		{ id: "m", kind: "mesh", gears: ["g1", "g2"], centreMm: 30 },
		{ id: "ls", kind: "leadscrew", diameterMm: 8, leadMm: 8, nut: "ln", mpn: "GOBILDA-3501-0804-0200" },
		{ id: "ln", kind: "leadnut", diameterMm: 8, leadMm: 8, mpn: "GOBILDA-3505-0804-3216" },
	]
	const mates = (t: DriveTrainPart[]) => mechanicsChecks({ ...s, values: { ...s.values, mechanics: { ...mech, driveTrain: t } } }).filter((v) => v.kind === "mech-mate").map((v) => v.message)
	assert.deepEqual(mates(train), [])
	assert.ok(mates(train.map((p) => (p.id === "m" ? { ...p, centreMm: 31 } : p)) as DriveTrainPart[]).length > 0)
})
