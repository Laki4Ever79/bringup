// The robot's bought mechanical parts (motors, wheels, caster, battery, distance sensor) in the parts list with where
// to buy each, and live price, stock and lead time where the shop states them (src/tools/robot-parts.ts).
import { test } from "node:test"
import assert from "node:assert/strict"
import { checkRobotParts, robotPartLines, robotPartNotes } from "../src/tools/robot-parts.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

const rover = (): ContractSnapshot => ({ revision: 3, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) })
const offerPage = (price: number, availability: string, extra: object = {}) => `<script type="application/ld+json">${JSON.stringify({ "@type": "Product", offers: { "@type": "Offer", price, priceCurrency: "USD", availability, ...extra } })}</script>`

test("the rover's parts list has two motors, a pair of wheels, a caster, the battery and the distance sensor", () => {
	const lines = robotPartLines(rover())
	const by = (item: string) => lines.find((l) => l.item === item)!
	assert.deepEqual(lines.map((l) => l.item), ["motor", "wheel", "caster", "battery", "distance sensor", "board screw", "caster screw", "caster nut", "sensor screw", "sensor nut", "clamp screw"])
	assert.equal(by("motor").mpn, "POLOLU-2367 100:1 MP 6V")
	assert.equal(by("motor").qty, 2)
	// Wheels are sold in pairs: two wheels are one pack.
	assert.equal(by("wheel").qty, 2)
	assert.equal(by("wheel").packs, 1)
	assert.equal(by("battery").qty, 1)
	assert.ok(by("motor").buy.length > 0 && by("motor").buy.every((b) => b.url.startsWith("https://")))
})

test("a robot with no mechanics has no robot parts", () => {
	const s = rover()
	delete (s.values as { mechanics?: unknown }).mechanics
	assert.deepEqual(robotPartLines(s), [])
})

test("a mock run checks nothing and says so", async () => {
	const r = await checkRobotParts(robotPartLines(rover()), { live: false })
	assert.ok(r.lines.every((l) => l.status === "not checked"))
	// The caster the rover uses (TENTE, an industrial part) has no shop link; the rest would be checked in a live run.
	assert.deepEqual(r.lines.map((l) => l.note), ["not checked (mock run)", "not checked (mock run)", "no shop link in catalog/mechanics.json", "not checked (mock run)", "not checked (mock run)", "not checked (mock run)", "not checked (mock run)", "not checked (mock run)", "not checked (mock run)", "not checked (mock run)", "not checked (mock run)"])
	assert.equal(r.knownUsd, null)
	assert.match(r.summary, /11 robot parts · not checked \(mock run\)/)
})

test("live: a shop's price, stock and lead time are used; a refusing shop is named and not priced", async () => {
	const shops: typeof fetch = (async (url: string) => {
		if (url.includes("pololu.com")) return new Response("denied", { status: 403 })
		if (url.includes("adafruit.com/product/2011")) return new Response(offerPage(12.5, "http://schema.org/OutOfStock"), { status: 200 })
		return new Response(offerPage(14.95, "http://schema.org/InStock", { deliveryLeadTime: { value: 3, unitCode: "DAY" } }), { status: 200 })
	}) as unknown as typeof fetch
	const r = await checkRobotParts(robotPartLines(rover()).slice(0, 5), { live: true, fetch: shops, now: () => new Date("2026-11-15T12:00:00Z") })
	const by = (item: string) => r.lines.find((l) => l.item === item)!
	assert.equal(by("motor").status, "not checked")
	assert.match(by("motor").note, /pololu\.com refused the automated check \(HTTP 403\)/)
	assert.equal(by("motor").unitUsd, null)
	assert.equal(by("battery").status, "out of stock")
	assert.equal(by("distance sensor").status, "in stock")
	assert.equal(by("distance sensor").leadDays, 3)
	assert.equal(by("distance sensor").lineUsd, 14.95)
	assert.equal(r.warn, true)
	assert.match(r.summary, /out of stock: battery/)
	// Pololu refused the wheels too, so the second shop in the catalog (The Pi Hut) priced them: one pair.
	assert.equal(by("wheel").supplier, "The Pi Hut")
	assert.equal(by("wheel").packs, 1)
	assert.match(r.summary, /not checked: motor, caster/)
	// Only what shops stated is added up, and the summary says how much is left out.
	assert.equal(r.knownUsd, Math.round((14.95 + 14.95 + 12.5) * 100) / 100)
	assert.match(r.summary, /\$42\.40 known for 3 of 5 lines/)
	assert.match(r.summary, /longest stated lead time 3 days/)
})

test("a part with no shop link in the catalog says so instead of failing", async () => {
	const lines = robotPartLines(rover())
	const caster = lines.find((l) => l.item === "caster")!
	const r = await checkRobotParts([{ ...caster, buy: [] }], { live: true, fetch: (async () => { throw new Error("no fetch expected") }) as unknown as typeof fetch })
	assert.equal(r.lines[0].status, "not checked")
	assert.match(r.lines[0].note, /no shop link in catalog\/mechanics\.json/)
})

// The user, 15 Nov 2026: "add to the parts list the items like nuts, bolts, bearings, threaded inserts, metal rods,...
// whatever can't be printed or ordered by the PCB provider". The rover's fasteners, counted from the chassis it gets.
test("the rover's fasteners are in the parts list, counted from its chassis: a screw per board hole, a screw and a nut per caster hole", async () => {
	const { chassisSpec } = await import("../src/tools/chassis.ts")
	const s = rover()
	const spec = chassisSpec(s)!
	const lines = robotPartLines(s)
	const by = (item: string) => lines.find((l) => l.item === item)
	const boardHoles = spec.boards.reduce((n, b) => n + b.holes.length, 0)
	assert.equal(by("board screw")?.qty, boardHoles)
	assert.match(by("board screw")!.mpn, /^M2x8 self-tapping/)
	assert.equal(by("caster screw")?.qty, spec.caster.holesMm.length)
	assert.match(by("caster screw")!.mpn, /^M4x10/)
	assert.equal(by("caster nut")?.qty, spec.caster.holesMm.length)
	// 200 board screws come in one pack.
	assert.equal(by("board screw")?.packs, 1)
})

test("what the design doesn't fasten yet is named, not left out", () => {
	const notes = robotPartNotes(rover())
	// The sensor's breakout is screwed to its bracket now (below); the battery isn't strapped yet.
	assert.ok(!notes.some((n) => /sensor bracket/.test(n)), notes.join("\n"))
	assert.ok(notes.some((n) => /battery/.test(n)), notes.join("\n"))
})

// The breakout's own holes (Adafruit's fab print: four at 0.80" × 0.50", M2.5) through the printed bracket, a machine
// screw and a nut in each, 15 Nov 2026. Before, the parts list said the bracket had no screw holes.
test("the distance sensor's breakout is screwed to its bracket: an M2.5 screw and nut per hole that lands above the plate", async () => {
	const { chassisSpec, SENSOR_HOLE_MM, sensorHoles } = await import("../src/tools/chassis.ts")
	const s = rover()
	const spec = chassisSpec(s)!
	assert.ok(spec.sensor.holes.length >= 2, JSON.stringify(spec.sensor))
	assert.equal(spec.sensor.holeDiaMm, SENSOR_HOLE_MM)
	// Four holes 20.32 mm apart across the robot, 12.7 mm up.
	const ys = [...new Set(spec.sensor.holes.map((h) => h.yMm))].sort((a, b) => a - b)
	assert.ok(Math.abs(ys[1] - ys[0] - 20.32) < 1e-6, ys.join(","))
	const lines = robotPartLines(s)
	const by = (item: string) => lines.find((l) => l.item === item)
	assert.equal(by("sensor screw")?.qty, spec.sensor.holes.length)
	assert.match(by("sensor screw")!.mpn, /^M2.5x8 pan head machine screw/)
	assert.equal(by("sensor nut")?.qty, spec.sensor.holes.length)
	// A breakout mounted low: its lower pair would sit in the plate, so only the upper pair is drilled.
	const low = sensorHoles({ mountHolesMm: [[-10.16, -6.35], [10.16, -6.35], [-10.16, 6.35], [10.16, 6.35]] }, { yMm: 0, zMm: 50.5 + 8.9 }, { thicknessMm: 3, clearanceMm: 50.5 })
	assert.deepEqual(low.map((h) => h.zMm), [15.25, 15.25])
	// A sensor whose catalog entry has no holes keeps the note.
	assert.deepEqual(sensorHoles({}, { yMm: 0, zMm: 60 }, { thicknessMm: 3, clearanceMm: 50.5 }), [])
})

test("each fastener fits its hole: the board's screw passes the board hole, the caster's screw its hole", async () => {
	const { hardwareFit } = await import("../src/tools/robot-parts.ts")
	assert.deepEqual(hardwareFit(rover()), [])
	const s = rover()
	// A caster whose holes are too small for its M4 screw.
	const { chassisSpec } = await import("../src/tools/chassis.ts")
	const spec = chassisSpec(s)!
	assert.match(hardwareFit(s, { ...spec, caster: { ...spec.caster, holeDiaMm: 3.4 } }).join(" "), /caster hole 3\.4 mm is smaller than the M4 screw/)
})

test("a fastener that doesn't fit its hole is a violation for the mechanics engineer", async () => {
	const { checkConsistency } = await import("../src/contract/consistency.ts")
	const { hardwareChecks } = await import("../src/tools/robot-parts.ts")
	const { chassisSpec } = await import("../src/tools/chassis.ts")
	assert.ok(!checkConsistency(rover(), {}).some((v) => v.kind === "hardware-misfit"))
	const spec = chassisSpec(rover())!
	const v = hardwareChecks(rover(), { ...spec, caster: { ...spec.caster, holeDiaMm: 3.4 } })
	assert.equal(v.length, 1)
	assert.equal(v[0].kind, "hardware-misfit")
	assert.deepEqual(v[0].affects, ["mechanics"])
	assert.match(v[0].message, /caster hole 3\.4 mm is smaller than the M4 screw/)
})
