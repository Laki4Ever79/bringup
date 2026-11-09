// The plain-code mechanics checks (src/mechanics/checks.ts): free and instant, run on every contract change.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mechanicsCheckOver, mechanicsChecksWith } from "../src/mechanics/checks.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { fixtureContract, roverFixture } from "./fixture.ts"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const kinds = (c: ContractSnapshot, cat: Any) => mechanicsChecksWith(c, cat).map((v) => v.kind)
function variant(edit: (v: Any, cat: Any) => void) {
	const { c, cat } = roverFixture()
	const copy = JSON.parse(JSON.stringify({ c, cat }))
	edit(copy.c.values, copy.cat)
	return copy as { c: ContractSnapshot; cat: Any }
}
const msg = (c: ContractSnapshot, cat: Any, kind: string) => mechanicsChecksWith(c, cat).find((v) => v.kind === kind)?.message ?? ""

test("the reference rover passes every mechanics check", () => {
	const { c, cat } = roverFixture()
	assert.deepEqual(mechanicsChecksWith(c, cat), [])
})

test("a board with no motion targets gets no mechanics checks at all", () => {
	assert.deepEqual(mechanicsChecksWith(fixtureContract(), roverFixture().cat), [])
})

test("a weak motor can't climb the edge", () => {
	const { c, cat } = variant((_v, k) => (k.mech.motors[0].stallTorqueNm = 0.02))
	assert.ok(kinds(c, cat).includes("mech-torque"))
	assert.match(msg(c, cat, "mech-torque"), /10 mm/)
})

test("too slow a motor misses the target speed", () => {
	const { c, cat } = variant((_v, k) => (k.mech.motors[0].noLoadRpm = 60))
	assert.match(msg(c, cat, "mech-speed"), /0\.3 m\/s/)
})

test("a short-range sensor can't stop the rover in time", () => {
	const { c, cat } = variant((_v, k) => (k.mech.sensors[0].rangeMm = 160))
	assert.ok(kinds(c, cat).includes("mech-stopping"))
	assert.match(msg(c, cat, "mech-stopping"), /estimate: floorMu 0\.6/)
})

test("a motor that stalls above the driver's peak is flagged, and the board is woken", () => {
	const { c, cat } = variant((_v, k) => (k.mech.motors[0].stallA = 3.2))
	const v = mechanicsChecksWith(c, cat).find((x) => x.kind === "mech-current")!
	assert.ok(v.affects.includes("board"))
})

test("a small pack can't last the runtime", () => {
	const { c, cat } = variant((_v, k) => (k.mech.batteries[0].mAh = 100))
	assert.match(msg(c, cat, "mech-runtime"), /30 min/)
})

test("a full cell over-volts a 3 V motor beyond 1.5×", () => {
	const { c, cat } = variant((_v, k) => (k.mech.motors[0].ratedV = 2.5))
	assert.match(msg(c, cat, "mech-voltage"), /1\.68×/)
})

test("a high, front-heavy build tips over when braking", () => {
	const { c, cat } = variant((v) => {
		v.mechanics.drive.wheelbaseMm = 15
		v.mechanics.battery.at.xMm = 60
	})
	assert.ok(kinds(c, cat).includes("mech-tipping"))
})

test("a plate smaller than the board doesn't fit", () => {
	const { c, cat } = variant((v) => (v.mechanics.chassis.plateMm = [50, 30]))
	assert.ok(mechanicsChecksWith(c, cat).some((v) => v.kind === "mech-fit" && /board main .* doesn't fit/.test(v.message)))
})

test("ground clearance below the edge height is a fit problem", () => {
	const { c, cat } = variant((v) => (v.motion.edgeMm = 40))
	assert.ok(kinds(c, cat).includes("mech-fit"))
})

test("no motor driver on any board is a wiring problem for the board agent", () => {
	const { c, cat } = variant((v) => (v.parts = v.parts.filter((p: Any) => p.role !== "motor-driver")))
	const w = mechanicsChecksWith(c, cat).find((x) => x.kind === "mech-wiring")!
	assert.deepEqual(w.affects, ["board"])
})

test("the driver on its own board gives the same verdicts (option B)", () => {
	const { c, cat } = roverFixture()
	const v = c.values as Any
	const drv = JSON.parse(JSON.stringify(c)) as Any
	drv.values.parts = v.parts.filter((p: Any) => p.role === "motor-driver")
	drv.values.pins = v.pins.filter((p: Any) => p.signal.startsWith("MOT_"))
	drv.values.outline = { widthMm: 30, heightMm: 20, thicknessMm: 1.6 }
	const main = JSON.parse(JSON.stringify(c)) as Any
	main.values.parts = v.parts.filter((p: Any) => p.role !== "motor-driver")
	main.values.pins = v.pins.filter((p: Any) => !p.signal.startsWith("MOT_"))
	const mech = JSON.parse(JSON.stringify(v.mechanics))
	mech.chassis.boards.push({ name: "drive", at: { xMm: -45, yMm: 0 }, rotDeg: 0 })
	assert.deepEqual(mechanicsCheckOver(v.motion, mech, [{ name: "main", snapshot: main }, { name: "drive", snapshot: drv }], cat), [])
})

test("the firmware's hardware layer must use the contract's pins (the pin-mismatch check reads hw_pins.h)", async () => {
	const { parsePinsHeader } = await import("../src/codegen/firmware.ts")
	const { checkConsistency } = await import("../src/contract/consistency.ts")
	const { c } = roverFixture()
	const good = "#define MOT_AIN1 4\n#define MOT_AIN2 5\n#define MOT_BIN1 6\n#define MOT_BIN2 7\n#define I2C_SDA 8\n#define I2C_SCL 9\n#define ROVER_STOP_MM 200\n"
	assert.deepEqual(parsePinsHeader(good), { MOT_AIN1: 4, MOT_AIN2: 5, MOT_BIN1: 6, MOT_BIN2: 7, I2C_SDA: 8, I2C_SCL: 9 })
	const firmware = (h: string) => ({ revision: 1, ok: true, pins: parsePinsHeader(h), log: "" })
	assert.deepEqual(checkConsistency(c, { firmware: firmware(good) }).filter((v) => v.kind === "pin-mismatch"), [])
	const bad = checkConsistency(c, { firmware: firmware(good.replace("MOT_AIN1 4", "MOT_AIN1 3")) }).filter((v) => v.kind === "pin-mismatch")
	assert.equal(bad.length, 1)
	assert.match(bad[0].message, /MOT_AIN1 on GPIO3, contract says GPIO4/)
})

test("a failed simulated drive wakes mechanics and firmware; one that couldn't run wakes nobody", async () => {
	const { checkConsistency } = await import("../src/contract/consistency.ts")
	const { c } = roverFixture()
	const drive = (result: "pass" | "fail" | "not run") => ({ revision: 1, dir: "", result, reason: result === "fail" ? "hit the wall (wall_front) at 4.20 s" : "QEMU is not installed", segments: [] })
	const failed = checkConsistency(c, { drive: drive("fail") }).filter((v) => v.kind === "mech-drive")
	assert.equal(failed.length, 1)
	assert.match(failed[0].message, /hit the wall/)
	assert.deepEqual(failed[0].affects, ["mechanics", "firmware"])
	assert.deepEqual(checkConsistency(c, { drive: drive("not run") }).filter((v) => v.kind === "mech-drive"), [])
	assert.deepEqual(checkConsistency(c, { drive: drive("pass") }).filter((v) => v.kind === "mech-drive"), [])
})
