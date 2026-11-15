import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chassisSpec } from "../src/tools/chassis.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import { controllersYaml, robotUrdf, maxWheelRadS } from "../src/ros/urdf.ts"
import { writeRosPackage } from "../src/ros/package.ts"
import { rosControllerChecks, rosPackageChecks, rosUrdfChecks } from "../src/ros/checks.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

const spec = () => chassisSpec({ revision: 9, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) } as ContractSnapshot)!

test("the URDF carries the design: REP-103 metres, the wheels at half the track and their radius, the design's mass", () => {
	const s = spec()
	const u = robotUrdf(s, { name: "rover", hardware: "bringup", port: "/dev/ttyACM0" })
	assert.match(u, /<link name="base_footprint"\/>/)
	assert.match(u, new RegExp(`<joint name="left_wheel_joint" type="continuous">[\\s\\S]*?<origin xyz="[\\d.]+ ${s.drive.trackMm / 2000} ${s.drive.wheelDiameterMm / 2000}"`))
	assert.match(u, /<plugin>bringup_hardware\/BringupSystem<\/plugin>[\s\S]*<param name="port">\/dev\/ttyACM0<\/param>/)
	assert.match(u, /<sensor name="range_sensor">/)
	assert.deepEqual(rosUrdfChecks(s, u), [])
})

test("the controllers' settings come from the drive, the brief's speed within the motor's, the firmware's tick", () => {
	const s = spec()
	const y = controllersYaml(s)
	assert.match(y, new RegExp(`wheel_separation: ${s.drive.trackMm / 1000}`))
	assert.match(y, new RegExp(`wheel_radius: ${s.drive.wheelDiameterMm / 2000}`))
	assert.match(y, /open_loop: true/)
	assert.match(y, /update_rate: 30/)
	assert.match(y, /linear\.x\.max_velocity: 0\.3 /)
	assert.deepEqual(rosControllerChecks(s, y), [])
	assert.ok(maxWheelRadS(s) > 10 && maxWheelRadS(s) < 13)
})

test("a hand-edited stale YAML is caught: the old 60 mm wheel, a speed the motors can't give, a rate over the firmware's tick", () => {
	const s = spec()
	const y = controllersYaml(s).replace(/wheel_radius: [\d.]+/, "wheel_radius: 0.03").replace(/linear\.x\.max_velocity: [\d.]+/, "linear.x.max_velocity: 1.0").replace(/update_rate: \d+/, "update_rate: 100")
	const f = rosControllerChecks(s, y)
	assert.deepEqual(f.map((x) => x.kind).sort(), ["ros-limits", "ros-rate", "ros-wheel-geometry"])
	assert.match(f.find((x) => x.kind === "ros-wheel-geometry")!.message, /wheel_radius is 0\.03, the design's wheel is 0\.04 m/)
})

test("the package is written with both hardware variants and passes its own checks; an edited URDF mass is caught", () => {
	const s = spec()
	const pkg = writeRosPackage(mkdtempSync(join(tmpdir(), "bringup-ros-")), s, { robot: "rover", revision: 9 })
	assert.match(readFileSync(join(pkg, "package.xml"), "utf8"), /<exec_depend>bringup_hardware<\/exec_depend>/)
	assert.match(readFileSync(join(pkg, "launch", "bringup.launch.py"), "utf8"), /hardware/)
	assert.deepEqual(rosPackageChecks(s, pkg), [])
	const u = join(pkg, "urdf", "rover.mock.urdf")
	writeFileSync(u, readFileSync(u, "utf8").replace(/<mass value="([\d.]+)"\/>/, (_m, v) => `<mass value="${Number(v) * 2}"/>`))
	assert.deepEqual(rosPackageChecks(s, pkg).map((x) => x.kind), ["ros-inertials"])
})
