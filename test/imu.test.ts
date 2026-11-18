// Every robot carries an IMU (the user, 17 Nov 2026, asked which robots should: "Every robot"): the LSM6DS3TR-C added
// in code, wired by the board generator, and the firmware's turn closed on its heading.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { withRobotImu } from "../src/contract/imu-auto.ts"
import { loadCatalog } from "../src/tools/parts-search.ts"
import { generatedNets, i2cDeviceTraces, imuLands, supportParts } from "../src/codegen/circuit.ts"
import { roverHeader } from "../src/mechanics/firmware.ts"
import { driverSet } from "../src/tools/driver-tests.ts"
import { unconnectedParts } from "../src/contract/consistency.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

const catalog = loadCatalog(fileURLToPath(new URL("..", import.meta.url))) as never
const rover = () => JSON.parse(readFileSync(new URL("./fixtures/cc-rover-9-rev24.json", import.meta.url), "utf8")) as ContractSnapshot
const withImu = () => {
	const s = rover()
	s.values.parts = withRobotImu(s.values.parts!, catalog, s.values.mechanics).parts
	return s
}

test("a robot's parts get the IMU once, under a free U ref", () => {
	const s = rover()
	const r = withRobotImu(s.values.parts!, catalog, s.values.mechanics)
	const imu = r.parts.filter((p) => p.role === "imu")
	assert.equal(imu.length, 1)
	assert.equal(imu[0].mpn, "LSM6DS3TR-C")
	assert.ok(!s.values.parts!.some((p) => p.ref === imu[0].ref), "a ref no other part has")
	assert.equal(withRobotImu(r.parts, catalog, s.values.mechanics).note, null, "added once")
})

test("a machine that doesn't drive on wheels (a CNC: no mechanics.drive) gets no IMU", () => {
	const s = rover()
	assert.equal(withRobotImu(s.values.parts!, catalog, null).note, null)
	assert.equal(withRobotImu(s.values.parts!, catalog, { ...s.values.mechanics!, drive: undefined } as never).note, null)
})

test("the board wires it on the bus in I2C mode at 0x6A, with 100 nF on VDD and VDDIO, and nothing left unconnected", () => {
	const s = withImu()
	const u = s.values.parts!.find((p) => p.role === "imu")!.ref
	const n = generatedNets(s)
	for (const pin of ["GND", "GND_2", "SA0", "SDX", "SCX"]) assert.ok(n.get("GND")!.includes(`${u}.${pin}`), pin)
	for (const pin of ["VDD", "VDDIO", "CS"]) assert.ok(n.get("V3V3")!.includes(`${u}.${pin}`), pin)
	assert.deepEqual(i2cDeviceTraces(s).filter((t) => t.ref === u).map((t) => `${t.net}:${t.pin}`).sort(), ["I2C_SCL:SCL", "I2C_SDA:SDA"])
	const caps = supportParts(s).filter((x) => /decoupling on U\d+\.VDD/.test(x.job ?? ""))
	assert.equal(caps.filter((x) => x.job!.startsWith(`decoupling on ${u}.`)).length, 2)
	assert.deepEqual(unconnectedParts(s).map((v) => v.message.split(" is ")[0]), [])
})

test("the land pattern: 14 lands, 0.5 mm pitch, numbered counter-clockwise from the top-left, none overlapping", () => {
	const l = imuLands()
	assert.deepEqual(l.map((x) => x.pin), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
	assert.ok(l[0].x < 0 && l[0].y > 0, "pin 1 at the top left")
	for (const a of l) for (const b of l) if (a !== b) assert.ok(Math.abs(a.x - b.x) >= (a.w + b.w) / 2 + 0.15 || Math.abs(a.y - b.y) >= (a.h + b.h) / 2 + 0.15, `lands ${a.pin} and ${b.pin} closer than 0.15 mm`)
})

test("the firmware: the IMU's driver and its heading turn are built in only with an IMU", () => {
	const s = withImu()
	assert.match(roverHeader(s), /#define IMU_LSM6DS3 1/)
	assert.match(roverHeader(s), /#define ROVER_TURN_RAD 2\.3562f/)
	assert.ok(driverSet(s).includes("lsm6ds3"))
	assert.doesNotMatch(roverHeader(rover()), /IMU_LSM6DS3|ROVER_TURN_RAD/)
})
