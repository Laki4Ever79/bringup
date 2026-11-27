// The turn calibration (26 Nov 2026): the design's mechanics.drive.turnScale, the firmware's ROVER_TURN_SCALE, and the
// simulation's reading of a calibration spin (src/tools/drive.ts turnCalibrationFrom). The firmware's own spin is
// tested on the host in test/goto-point.test.ts; the spin in the physics in test/mech-drive.int.test.ts.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mechanicsShapeError } from "../src/mechanics/shape.ts"
import { roverHeader } from "../src/mechanics/firmware.ts"
import { turnCalibrationFrom } from "../src/tools/drive.ts"
import { EUROBOT_BOARD } from "../src/inference/scripts.ts"

const eurobot = () => JSON.parse(JSON.stringify(EUROBOT_BOARD))

test("turnScale is optional, a counted-over-real factor between 0.8 and 1.25; the firmware gets it as ROVER_TURN_SCALE", () => {
	const v = eurobot()
	assert.equal(mechanicsShapeError(v.mechanics), null)
	assert.doesNotMatch(roverHeader({ revision: 1, versions: {} as never, values: v }), /ROVER_TURN_SCALE/)
	v.mechanics.drive.turnScale = 1.0055
	assert.equal(mechanicsShapeError(v.mechanics), null)
	assert.match(roverHeader({ revision: 1, versions: {} as never, values: v }), /#define ROVER_TURN_SCALE 1\.00550f/)
	for (const bad of [0.5, 2, "1.01"]) { v.mechanics.drive.turnScale = bad; assert.match(mechanicsShapeError(v.mechanics) ?? "", /turnScale/) }
})

test("a calibration spin's counted turns over the physics' yaw give the scale, through the yaw's wrap, both ways together", () => {
	// 8 quarter-turns each way (12.566 rad counted), the body really turning 1 % less; the yaw wraps at ±π.
	const real = (4 * Math.PI) / 1.01
	const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))
	const rows: number[][] = []
	for (let t = 0; t <= 30; t += 0.1) {
		const yaw = t < 1 ? 0 : t < 11 ? (real * (t - 1)) / 10 : t < 12 ? real : t < 22 ? real - (real * (t - 12)) / 10 : 0
		rows.push([+t.toFixed(3), 0, 0, wrap(yaw)])
	}
	const uart = "R 0\nCAL start 1000 8\nODO 1\nCAL turned ccw 12000 12.56637\nCAL turned cw 23000 12.56637 scale 1.00000\nCAL coast 26000 13.4\n"
	const c = turnCalibrationFrom(uart, rows)!
	assert.equal(c.coastMm, 13.4)
	assert.ok(Math.abs(c.scale - 1.01) < 1e-3, `scale ${c.scale}`)
	assert.ok(Math.abs(c.realRad[0] - real) < 1e-6 && Math.abs(c.realRad[1] - real) < 1e-6)
	// A firmware that already had a factor reports with it: the result is the whole factor.
	const again = turnCalibrationFrom(uart.replace("scale 1.00000", "scale 1.01000").replace(/12\.56637/g, "12.44195"), rows)!
	assert.ok(Math.abs(again.scale - 1.01) < 2e-3, `again ${again.scale}`)
	// No calibration in the log (an older firmware, or it never finished): null, and the drive goes on without.
	assert.equal(turnCalibrationFrom("R 0\nCAL start 1000 8\n", rows), null)
})

test("coastMm is optional, 0 to 200 mm; the firmware gets it as ROVER_COAST_MM, and the request mapper reads it", async () => {
	const { mechanicsFromRequest } = await import("../src/runner/request-map.ts")
	const v = eurobot()
	assert.doesNotMatch(roverHeader({ revision: 1, versions: {} as never, values: v }), /ROVER_COAST_MM/)
	v.mechanics.drive.coastMm = 21.5
	assert.equal(mechanicsShapeError(v.mechanics), null)
	assert.match(roverHeader({ revision: 1, versions: {} as never, values: v }), /#define ROVER_COAST_MM 21\.5f/)
	for (const bad of [-1, 250, "20"]) { v.mechanics.drive.coastMm = bad; assert.match(mechanicsShapeError(v.mechanics) ?? "", /coastMm/) }
	assert.equal(mechanicsFromRequest("set the coast to 21.5 mm", eurobot().mechanics)!.value.drive.coastMm, 21.5)
	assert.equal(mechanicsFromRequest("the coast is nice", eurobot().mechanics), null)
})
