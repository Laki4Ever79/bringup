import { test } from "node:test"
import assert from "node:assert/strict"
import { checkConsistency, type ViolationKind } from "../src/contract/consistency.ts"
import { fixtureArtifacts, fixtureContract } from "./fixture.ts"

function only(kind: ViolationKind, affects: string[], mutate: (c: ReturnType<typeof fixtureContract>, a: ReturnType<typeof fixtureArtifacts>) => void) {
	const c = fixtureContract()
	const a = fixtureArtifacts()
	mutate(c, a)
	const v = checkConsistency(c, a)
	assert.equal(v.length, 1, JSON.stringify(v))
	assert.equal(v[0].kind, kind)
	assert.deepEqual(v[0].affects, affects)
}

test("consistent fixture has no violations", () => {
	assert.deepEqual(checkConsistency(fixtureContract(), fixtureArtifacts()), [])
})

test("outline-mismatch", () => only("outline-mismatch", ["board"], (_c, a) => { a.board!.widthMm = 52 }))

test("net-missing", () => only("net-missing", ["board"], (_c, a) => { a.board!.nets.I2C_SDA = ["U2.SDA"] }))

// The firmware is generated from the pins: a mismatch only means it has not been rebuilt yet, so it wakes no agent
// (real run on file sync: the firmware agent "fixed" the contract to match a stale build).
test("pin-mismatch", () => only("pin-mismatch", [], (_c, a) => { a.firmware!.pins.I2C_SCL = 7 }))

test("cutout-missing", () => only("cutout-missing", ["enclosure"], (_c, a) => { a.enclosure!.cutouts = [] }))

test("cutout-misaligned", () => only("cutout-misaligned", ["enclosure"], (_c, a) => { a.enclosure!.cutouts[0].offsetMm = 18 }))

test("rail-overload", () => only("rail-overload", ["architect", "parts"], (c) => { c.values.rails![0].loadMa = 600 }))

test("firmware-build-failed", () => only("firmware-build-failed", ["firmware"], (_c, a) => { a.firmware!.ok = false }))

test("rules skip missing artifacts", () => {
	assert.deepEqual(checkConsistency(fixtureContract(), {}), [])
})

const CORNERS = [[3, 3], [47, 3], [3, 27], [47, 27]]
const withMounting = (a: ReturnType<typeof fixtureArtifacts>) => {
	a.board!.holes = CORNERS.map(([xMm, yMm]) => ({ xMm, yMm, diameterMm: 2.2 }))
	a.enclosure!.standoffs = CORNERS.map(([xMm, yMm]) => ({ xMm, yMm, holeMm: 1.6 }))
	return a
}

test("standoffs under every board hole are consistent", () => {
	assert.deepEqual(checkConsistency(fixtureContract(), withMounting(fixtureArtifacts())), [])
})

test("standoff-mismatch: a standoff off its hole", () =>
	only("standoff-mismatch", ["enclosure"], (_c, a) => {
		withMounting(a).enclosure!.standoffs![1].xMm = 46
	}))

test("standoff-mismatch: a hole with no standoff, and a standoff with no hole", () => {
	const a = withMounting(fixtureArtifacts())
	a.enclosure!.standoffs!.pop()
	a.board!.holes!.shift()
	const v = checkConsistency(fixtureContract(), a)
	assert.deepEqual(v.map((x) => x.kind), ["standoff-mismatch", "standoff-mismatch"])
	assert.match(v[0].message, /47, 27/)
	assert.match(v[1].message, /3, 3/)
})

test("the standoff rule waits until both the board and the case report their holes", () => {
	const a = withMounting(fixtureArtifacts())
	delete a.board!.holes
	a.enclosure!.standoffs = []
	assert.deepEqual(checkConsistency(fixtureContract(), a), [])
})

// Real run 13: the board wired J1.DN to its pads pin9 and pin11 (the USB-C footprint has no DN port), and the check
// still asked for "J1.DN", a violation nobody could fix.
test("a pin on the USB-C connector is connected when the net reaches that signal's pads", () => {
	const c = fixtureContract()
	c.values.parts!.push({ ref: "J1", role: "usb-c", mpn: "TYPE-C-31-M-12", lcsc: "C165948", footprint: "usbc", pins: ["VBUS", "GND", "CC1", "CC2", "DP", "DN"] })
	c.values.pins!.push({ signal: "USB_DN", gpio: 18, partRef: "J1", partPin: "DN" })
	const a = fixtureArtifacts()
	a.board!.nets.USB_DN = ["U1.GPIO18", "J1.pin9", "J1.pin11"]
	assert.deepEqual(checkConsistency(c, a).filter((v) => v.kind === "net-missing"), [])
	a.board!.nets.USB_DN = ["U1.GPIO18"]
	assert.match(checkConsistency(c, a).find((v) => v.kind === "net-missing")!.message, /J1\.DN/)
})

test("part-mismatch: the board places another part than the contract lists", () =>
	only("part-mismatch", ["board"], (c, a) => {
		a.board!.parts = Object.fromEntries(c.values.parts!.map((p) => [p.ref, { mpn: p.mpn, pins: p.pins }]))
		// The board was built before the sensor swap; the contract has the new one.
		c.values.parts = c.values.parts!.map((p) => (p.ref === "U2" ? { ...p, mpn: "BME280", lcsc: "C92489" } : p))
	}))

test("part-mismatch: a contract part the board does not have", () =>
	only("part-mismatch", ["board"], (c, a) => {
		a.board!.parts = Object.fromEntries(c.values.parts!.filter((p) => p.ref !== "D1").map((p) => [p.ref, { mpn: p.mpn, pins: p.pins }]))
	}))

test("a board part with no MPN on record is not called a mismatch, and MPNs compare case-insensitively", () => {
	const c = fixtureContract()
	const a = fixtureArtifacts()
	a.board!.parts = Object.fromEntries(c.values.parts!.map((p, i) => [p.ref, { mpn: i === 0 ? null : p.mpn.toLowerCase(), pins: p.pins }]))
	assert.deepEqual(checkConsistency(c, a), [])
})

// Real run 19: the contract claimed about 6 months of history, the firmware kept 30 days. The depth is now generated
// from the contract, so what can still disagree is the claim and the flash: the LittleFS partition holds 0x160000 bytes.
test("a history depth the flash partition cannot hold at the contract's period is a violation for the architect", () => {
	const c = fixtureContract()
	c.values.requirements = { ...c.values.requirements!, historyDays: 180, dutyCycle: { activeMs: 100, periodS: 300, sleepUa: 5 } }
	const a = fixtureArtifacts()
	assert.deepEqual(checkConsistency(c, a).filter((v) => v.kind === "history-overflow"), [], "180 days at 300 s is about 207 KB")
	c.values.requirements = { ...c.values.requirements!, historyDays: 3650, dutyCycle: { activeMs: 100, periodS: 60, sleepUa: 5 } }
	const v = checkConsistency(c, a).find((x) => x.kind === "history-overflow")!
	assert.deepEqual([v.fields, v.affects], [["requirements"], ["architect"]])
	assert.match(v.message, /3650 days at 60 s is 21\.0 MB of readings; the firmware's LittleFS partition holds 1\.30 MB/)
})

// A sensor sealed in the case measures the box, not the room: the case needs a vent over it.
const U2_AT = { xMm: 46.5, yMm: 26 }
const withVent = (a: ReturnType<typeof fixtureArtifacts>) => {
	a.board!.placements = { U2: U2_AT }
	a.enclosure!.vents = [{ ref: "U2", xMm: 46, yMm: 25.5, widthMm: 7, heightMm: 6 }]
	return a
}

test("a vent over the sensor is consistent", () => {
	assert.deepEqual(checkConsistency(fixtureContract(), withVent(fixtureArtifacts())), [])
})

test("vent-missing: a sensor and a case without a vent", () =>
	only("vent-missing", ["enclosure"], (_c, a) => {
		withVent(a).enclosure!.vents = []
	}))

test("vent-missing: the vent is not over where the board placed the sensor", () =>
	only("vent-missing", ["enclosure"], (_c, a) => {
		withVent(a).board!.placements = { U2: { xMm: 10, yMm: 5 } }
	}))

test("vent-missing names the sensor and both positions", () => {
	const a = withVent(fixtureArtifacts())
	a.board!.placements = { U2: { xMm: 10, yMm: 5 } }
	assert.match(checkConsistency(fixtureContract(), a)[0].message, /U2.*\(10, 5\).*\(46, 25\.5\)/)
})

test("a case built before vents existed (no vents field) is not judged on them", () => {
	const a = fixtureArtifacts()
	assert.equal(a.enclosure!.vents, undefined)
	assert.deepEqual(checkConsistency(fixtureContract(), a), [])
})

// Real add-sensor run: the review removed the sensor's I2C pins and later the part came back without them.
test("sensor-unwired: a sensor part whose SDA/SCL aren't assigned to MCU GPIOs", () =>
	only("sensor-unwired", ["architect"], (c) => {
		c.values.pins = c.values.pins!.filter((p) => p.partPin !== "SCL")
	}))

test("sensor-unwired names the sensor and the unwired bus pins", () => {
	const c = fixtureContract()
	c.values.pins = []
	const v = checkConsistency(c, {}).find((x) => x.kind === "sensor-unwired")!
	assert.match(v.message, /sensor U2 \(SHT40-AD1B-R2\) has no GPIO on SDA, SCL/)
	assert.deepEqual(v.fields, ["pins"])
})

test("no sensor, nothing to wire", () => {
	const c = fixtureContract()
	c.values.parts = c.values.parts!.filter((p) => p.role !== "sensor")
	c.values.pins = []
	assert.ok(!checkConsistency(c, {}).some((x) => x.kind === "sensor-unwired"))
})
