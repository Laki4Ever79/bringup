// The checks on a bought compute board (src/system/compute.ts), on the real Raspberry Pi 5 record
// (catalog/modules/rpi-5.json) and the mechanics catalog's battery and motors.
import { test } from "node:test"
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { loadMechCatalog } from "../src/mechanics/catalog.ts"
import { moduleById } from "../src/system/bought.ts"
import { headerCheck, headerSignals, mechanicsCheck, powerBudget, railCheck, railNeed, type CarrierRegulator } from "../src/system/compute.ts"
import type { AssemblyBoard } from "../src/system/assembly.ts"
import type { Module } from "../src/modules/library.ts"

const ROOT = resolve(import.meta.dirname, "..")
const pi = moduleById("rpi-5")!
const mech = loadMechCatalog(ROOT)
const motor = mech.motors.find((m) => m.mpn.startsWith("POLOLU-2366"))!
const DOCS = /https:\/\/github\.com\/raspberrypi\/documentation\/.*power-supplies\.adoc/
const good: CarrierRegulator = { outV: 5.1, maxOutA: 5, maxInA: 12, efficiency: 0.92, source: { url: "https://example.com/reg.pdf", where: "table 1" } }
// A copy of the record with one value changed (the record itself is d9610c's and stays as it is).
const edited = (path: string, value: unknown): Module => {
	const m = structuredClone(pi)
	let x = m.compute as Record<string, unknown>
	const keys = path.split(".")
	for (const k of keys.slice(0, -1)) x = x[k] as Record<string, unknown>
	;(x[keys.at(-1)!] as Record<string, unknown>).value = value
	return m
}

test("the rail needs the Pi's 5 A at 5.1 V: the vendor's recommended supply already has its headroom", () => {
	const n = railNeed(pi)!
	assert.deepEqual([n.amps, n.volts, n.margin, n.supplyRating], [5, 5.1, 0, true])
	assert.deepEqual(railCheck(pi, good), [])
})

test("a forced too-small regulator is caught, naming both numbers and the Raspberry Pi power docs", () => {
	const f = railCheck(pi, { ...good, maxOutA: 3 })
	assert.equal(f.length, 1)
	assert.equal(f[0].level, "error")
	assert.match(f[0].message, /rated 3 A .* needs 5 A/)
	assert.match(f[0].message, DOCS)
	// Unknown is said, not passed.
	assert.match(railCheck(pi, { ...good, maxOutA: null })[0].message, /output current is unknown/)
	assert.match(railCheck(pi, null)[0].message, /isn't chosen yet; it must deliver 5 A at 5\.1 V/)
	// A rail at 5 V where the Pi asks 5.1 V and publishes no tolerance: a warning that says why.
	const v = railCheck(pi, { ...good, outV: 5.0 })
	assert.equal(v[0].level, "warning")
	assert.match(v[0].message, /publishes no tolerance/)
})

test("a module whose peak is its own draw gets the 20 % margin on the rail", () => {
	const m = structuredClone(pi)
	const peak = (m.compute as { currentA: { peak: { value: number; source: { where: string }; note?: string } } }).currentA.peak
	peak.value = 3; peak.source.where = "measured peak draw"; delete peak.note
	assert.equal(railNeed(m)!.amps, 3.6)
})

test("power budget: the Pi's peak plus two motors at stall against the 1S pack's rating is a brown-out", () => {
	const pack = mech.batteries.find((b) => b.mpn.startsWith("ADAFRUIT-2011"))!
	const f = powerBudget(pi, { battery: pack, motors: { part: motor, count: 2 }, regulator: good })
	const err = f.filter((x) => x.level === "error")
	assert.equal(err.length, 1, JSON.stringify(f))
	assert.match(err[0].message, /^brown-out risk: rpi-5's 5 A peak at 5\.1 V/)
	assert.match(err[0].message, /25\.5 W/)
	assert.match(err[0].message, /2 × POLOLU-2366/)
	assert.match(err[0].message, /over the ADAFRUIT-2011 .*'s 2 A discharge rating/)
	assert.match(err[0].message, DOCS)
	assert.match(err[0].message, /cdn-shop\.adafruit\.com/, "the battery's source")
	assert.ok(err[0].sources.length >= 2)
	// A pack big enough passes the budget (a hand-made 2S pack rated 15 A).
	const big = { ...pack, mpn: "BIG-2S", cutoffV: 6, fullV: 8.4, peakA: 15 }
	assert.deepEqual(powerBudget(pi, { battery: big, motors: { part: motor, count: 2 }, regulator: good }).filter((x) => x.level === "error"), [])
	// The regulator's input limit is the other bound.
	assert.match(powerBudget(pi, { battery: big, motors: null, regulator: { ...good, maxInA: 2 } })[0].message, /over the carrier regulator's 2 A input limit/)
})

test("power budget says what it can't check: no battery, unknown peak, no regulator", () => {
	assert.match(powerBudget(pi, { battery: null, motors: null, regulator: good })[0].message, /no battery chosen yet/)
	const noPeak = edited("currentA.peak", null)
	const f = powerBudget(noPeak, { battery: mech.batteries[0], motors: null, regulator: good })
	assert.equal(f[0].level, "warning")
	assert.match(f[0].message, /peak current is unknown/)
	const big = { ...mech.batteries[0], cutoffV: 6, fullV: 8.4, peakA: 15 }
	assert.match(powerBudget(pi, { battery: big, motors: null, regulator: null }).map((x) => x.message).join("\n"), /regulator isn't chosen yet/)
	assert.match(powerBudget(pi, { battery: big, motors: null, regulator: { ...good, maxInA: null } }).map((x) => x.message).join("\n"), /input current limit is unknown/)
})

test("header: the carrier's 5 V on pins 2 and 4, ground, and UART0 on 8/10 all land right; a pin mismatch is named", () => {
	const usb = headerSignals(pi, "usb")
	assert.deepEqual(usb.filter((s) => s.fn === "5V").map((s) => s.pin), [2, 4])
	assert.ok(usb.some((s) => s.fn === "GND" && s.pin === 6))
	assert.equal(usb.some((s) => s.fn.startsWith("UART")), false, "the default bridge is the MCU board's USB: no UART on the header")
	const uart = headerSignals(pi, "uart")
	assert.deepEqual(uart.filter((s) => s.fn.startsWith("UART")).map((s) => [s.fn, s.pin]), [["UART TX", 8], ["UART RX", 10]])
	assert.deepEqual(headerCheck(pi, uart), [])
	assert.deepEqual(headerCheck(pi, [{ fn: "I2C SDA", pin: 3 }, { fn: "I2C SCL", pin: 5 }, { fn: "PWM", pin: 32 }]), [])
	// TX and RX swapped.
	const swapped = headerCheck(pi, [{ fn: "UART TX", pin: 10, net: "PI_TX" }])
	assert.equal(swapped.length, 1)
	assert.match(swapped[0].message, /UART TX \(PI_TX\) lands on the wrong pin .*pin 10 is GPIO15 UART RX; UART TX is on pin 8/)
	assert.match(swapped[0].message, /gpio-on-raspberry-pi\.adoc/)
	// 5 V onto a GPIO, and onto 3V3.
	assert.match(headerCheck(pi, [{ fn: "5V", pin: 1 }])[0].message, /5 V goes only onto the 5 V pins \(2, 4\): pin 1 is 3V3/)
	assert.match(headerCheck(pi, [{ fn: "5V", pin: 8 }])[0].message, /3\.3 V GPIO that isn't 5 V tolerant/)
	assert.match(headerCheck(pi, [{ fn: "GND", pin: 41 }])[0].message, /pin 41, which rpi-5's header doesn't have/)
})

test("mechanics: the Pi fits the plate or is named; it mustn't stand in front of the sensor; its unknown height is a warning", () => {
	const at = (xMm: number, yMm = 0): AssemblyBoard => ({ name: "brain", xMm, yMm, rotDeg: 0, outline: { widthMm: 85, heightMm: 56 }, outlineSource: "built" })
	const plate = { lengthMm: 180, widthMm: 110 }
	const main: AssemblyBoard = { name: "main", xMm: -60, yMm: 0, rotDeg: 0, outline: { widthMm: 40, heightMm: 30 }, outlineSource: "built" }
	const ok = mechanicsCheck(pi, { placed: at(20), plate, others: [main] })
	assert.deepEqual(ok.map((f) => f.level), ["warning"], "on the plate, clear of main: only the height")
	assert.match(ok[0].message, /unknown height/)
	assert.match(ok[0].message, /STEP model/, "the record's own note says why")
	const off = mechanicsCheck(pi, { placed: at(60), plate, others: [] })
	assert.match(off[0].message, /brain \(rpi-5, 85 × 56 mm: https:\/\/datasheets\.raspberrypi\.com\/rpi5\/raspberry-pi-5-mechanical-drawing\.pdf .*sticks out of the 180 × 110 mm plate/)
	assert.match(mechanicsCheck(pi, { placed: at(-40), plate, others: [main] })[0].message, /overlaps main/)
	// The sensor looks forward from x 0: a Pi wholly ahead of it at its height blocks it, even counting the bare board.
	const sensor = { xMm: 0, yMm: 0, zMm: 9, sizeMm: [3, 21, 18] as [number, number, number] }
	const blocked = mechanicsCheck(pi, { placed: at(50), plate: { lengthMm: 200, widthMm: 110 }, others: [], sensor, baseZMm: 8 })
	assert.match(blocked.map((f) => f.message).join("\n"), /stands in front of the distance sensor/)
	assert.deepEqual(mechanicsCheck(pi, { placed: at(-50), plate: { lengthMm: 200, widthMm: 110 }, others: [], sensor, baseZMm: 8 }).map((f) => f.level), ["warning"])
	// With a height known, the brief's limit is checked instead of the warning.
	const tall = edited("tallestMm", 20)
	;(tall.compute as { tallestMm: { source: unknown } }).tallestMm.source = { url: "https://example.com/step", where: "measured" }
	assert.match(mechanicsCheck(tall, { placed: at(20), plate, others: [], baseZMm: 19, maxHeightMm: 35 })[0].message, /reaches 39 mm .* over the brief's 35 mm/)
})
