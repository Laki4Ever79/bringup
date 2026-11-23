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
	const pkg = writeRosPackage(tempDir(), s, { robot: "rover", revision: 9 })
	assert.match(readFileSync(join(pkg, "package.xml"), "utf8"), /<exec_depend>bringup_hardware<\/exec_depend>/)
	assert.match(readFileSync(join(pkg, "launch", "bringup.launch.py"), "utf8"), /hardware/)
	assert.deepEqual(rosPackageChecks(s, pkg), [])
	const u = join(pkg, "urdf", "rover.mock.urdf")
	writeFileSync(u, readFileSync(u, "utf8").replace(/<mass value="([\d.]+)"\/>/, (_m, v) => `<mass value="${Number(v) * 2}"/>`))
	assert.deepEqual(rosPackageChecks(s, pkg).map((x) => x.kind), ["ros-inertials"])
})

import { bagStats, diagnose, i2cRise } from "../src/ros/diagnose.ts"
import { tempDir } from "./helpers.ts"

const rover = () => ({ revision: 9, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) }) as ContractSnapshot
const healthy = { "/range_sensor_broadcaster/range": { count: 568, durationS: 18.9 }, "/joint_states": { count: 569, durationS: 18.9 } }

test("a healthy run (the QEMU acceptance bag: 568 range readings in 18.9 s) has nothing to diagnose", () => {
	assert.deepEqual(diagnose(spec(), rover(), { topics: healthy, achievedSpeedMps: 0.293, commandedSpeedMps: 0.3 }), [])
})

test("slow range readings on a long sensor cable trace to the board's I2C pull-ups, with the value to fit", () => {
	const s = spec()
	s.sensor.xMm += 2300 // the sensor 2.3 m from the board (a mast or a trailer): about 120 pF of cable
	const bus = i2cRise(s, rover())
	assert.ok(bus.riseNs > 1000, `rise ${bus.riseNs}`)
	const d = diagnose(s, rover(), { topics: { ...healthy, "/range_sensor_broadcaster/range": { count: 150, durationS: 18.9 } } })
	assert.equal(d.length, 1)
	assert.match(d[0].cause, /10 kΩ pull-ups .* over the 1000 ns standard mode allows/)
	assert.match(d[0].fix, /stronger I2C pull-ups on the board: \d+ Ω or less/)
	assert.deepEqual(d[0].affects, ["parts", "mechanics"])
	assert.equal(d[0].confidence, "measured")
})

test("slow range readings on a short cable are not blamed on the bus", () => {
	const d = diagnose(spec(), rover(), { topics: { ...healthy, "/range_sensor_broadcaster/range": { count: 150, durationS: 18.9 } } })
	assert.match(d[0].cause, /not the bus's rise time/)
	assert.equal(d[0].confidence, "suspect")
})

test("slow wheel states at a low console baud trace to the link; a speed shortfall to the motors' margin", () => {
	const d = diagnose(spec(), rover(), { topics: { ...healthy, "/joint_states": { count: 200, durationS: 18.9 } }, consoleBaud: 9600 })
	assert.match(d[0].cause, /9600 baud carries about \d+ command-and-report pairs/)
	const s = diagnose(spec(), rover(), { topics: healthy, achievedSpeedMps: 0.2, commandedSpeedMps: 0.3 })
	assert.equal(s[0].affects[0], "mechanics")
	assert.match(s[0].symptom, /reached 0\.20 m\/s of the 0\.30 m\/s commanded/)
})

test("ros2 bag info is read into per-topic rates", () => {
	const info = "Duration:          18.937040311s\nMessages: 2923\nTopic information: Topic: /joint_states | Type: sensor_msgs/msg/JointState | Count: 569 | Serialization Format: cdr\n                   Topic: /range_sensor_broadcaster/range | Type: sensor_msgs/msg/Range | Count: 568 | Serialization Format: cdr"
	const s = bagStats(info)
	assert.deepEqual(s["/joint_states"], { count: 569, durationS: 18.937040311 })
	assert.equal(Object.keys(s).length, 2)
})

test("the hardware plugin's template installs only folders git keeps (an empty include/ broke colcon in a run's workspace)", async () => {
	const { existsSync: exists, readdirSync } = await import("node:fs")
	const dir = join(import.meta.dirname, "..", "templates", "ros", "bringup_hardware")
	const cmake = readFileSync(join(dir, "CMakeLists.txt"), "utf8")
	for (const m of cmake.matchAll(/install\(DIRECTORY (\S+?)\/? /g)) assert.ok(exists(join(dir, m[1])) && readdirSync(join(dir, m[1])).length > 0, `${m[1]} is missing or empty`)
})

// A check whose value never arrived (no odometry: nan) is written as null, never as NaN: JSON has no NaN and the run
// reads acceptance.json with JSON.parse (mock rover run, 16 Nov 2026: "measured": NaN left the acceptance unread).
test("the acceptance script writes a value that never arrived as null, so its JSON parses", async () => {
	const { acceptanceScript } = await import("../src/ros/acceptance.ts")
	const { execFileSync } = await import("node:child_process")
	const src = acceptanceScript(spec())
	const helper = /( {4}def json_safe\(x\):[\s\S]*?\n {4}def check\(name, ok, measured, expected\):\n.*\n)/.exec(src)
	assert.ok(helper, "the script has json_safe() and check()")
	const py = `import json, math\nchecks = []\n${helper[1].replace(/^ {4}/gm, "")}\ncheck("speed", False, float("nan"), 0.3)\nprint(json.dumps(checks, allow_nan=False))\n`
	const out = JSON.parse(execFileSync("python3", ["-c", py], { encoding: "utf8" }))
	assert.deepEqual(out, [{ name: "speed", pass: false, measured: null, expected: 0.3 }])
})

// Mock rover runs on adopt feed1d1 (16 Nov 2026): every acceptance raised "'list' object is not callable" and recorded
// no check, because main() later rebound the helper's name (finite = [readings]). The whole script is checked: no
// function nested in a scope may be rebound by an assignment in that scope.
test("the acceptance script never rebinds a helper's name in the scope that defines it", async () => {
	const { acceptanceScript } = await import("../src/ros/acceptance.ts")
	const { execFileSync } = await import("node:child_process")
	const py = `import ast, json, sys
tree = ast.parse(sys.stdin.read())
clashes = []
for scope in ast.walk(tree):
    if not isinstance(scope, (ast.FunctionDef, ast.Module)):
        continue
    body = list(ast.iter_child_nodes(scope))
    defs = {n.name for n in body if isinstance(n, ast.FunctionDef)}
    for n in ast.walk(scope):
        if isinstance(n, (ast.Assign, ast.AugAssign, ast.AnnAssign)):
            for t in (n.targets if isinstance(n, ast.Assign) else [n.target]):
                if isinstance(t, ast.Name) and t.id in defs:
                    clashes.append(t.id)
print(json.dumps(sorted(set(clashes))))
`
	const out = JSON.parse(execFileSync("python3", ["-c", py], { input: acceptanceScript(spec()), encoding: "utf8" }))
	assert.deepEqual(out, [])
})

// The QEMU back end starts ROS once the firmware's console takes a connection (runDrive onConsoleReady): the probe.
test("portOpen tells a listening port from a closed one", async () => {
	const { portOpen } = await import("../src/tools/drive.ts")
	const { createServer } = await import("node:net")
	const srv = createServer((c) => c.end())
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()))
	const port = (srv.address() as { port: number }).port
	assert.equal(await portOpen(port), true)
	await new Promise<void>((r) => srv.close(() => r()))
	assert.equal(await portOpen(port), false)
})

// Real inertias (19 Nov 2026, text-to-cad's lesson): the body's inertia is composed from the parts the mass and centre of
// mass come from, not one plate-sized box (which overstated the rover's by 28-45 %).
test("the URDF body's inertia is composed from its parts: the same mass, a smaller spread than the plate box, a real ixz", async () => {
	const { bodyOf, bodyInertia } = await import("../src/ros/urdf.ts")
	const s = spec()
	const b = bodyOf(s)
	const parts = s.bodyParts!
	assert.ok(parts.some((p) => p.what === "battery") && !parts.some((p) => p.what.startsWith("wheel:") || p.what === "caster"))
	assert.ok(Math.abs(parts.reduce((t, p) => t + p.massG, 0) / 1000 - b.bodyKg) < 1e-9, "the parts weigh what the body does")
	const i = bodyInertia(s, b.com)!
	const L = s.plate.lengthMm / 1000, W = s.plate.widthMm / 1000
	assert.ok(i.izz < (b.bodyKg * (L * L + W * W)) / 12, "the weight sits nearer the centre than a uniform plate")
	assert.notEqual(i.ixz, 0, "the pack forward and up of the centre of mass tilts the tensor")
	const u = robotUrdf(s)
	assert.match(u, /The body's inertia is composed from its \d+ parts/)
	assert.match(u, new RegExp(`izz="${Number(i.izz.toPrecision(8))}"`))
	assert.deepEqual(rosUrdfChecks(s, u), [])
	// A spec written before bodyParts: the old box, still a valid URDF.
	const { bodyParts: _, ...old } = s
	assert.equal(bodyInertia(old, b.com), null)
	assert.deepEqual(rosUrdfChecks(old, robotUrdf(old)), [])
})

test("what check_urdf would refuse is caught: two roots, a dangling joint, a non-positive mass, an impossible inertia", async () => {
	const { urdfStructureChecks, symEigen3 } = await import("../src/ros/checks.ts")
	assert.deepEqual(symEigen3(2, 3, 1, 0, 0, 0), [1, 2, 3])
	const e = symEigen3(2, 2, 3, 1, 0, 0)!
	assert.ok(Math.abs(e[0] - 1) < 1e-6 && Math.abs(e[1] - 3) < 1e-6 && Math.abs(e[2] - 3) < 1e-6, "a repeated root: the closed form is good to ~1e-8")
	const u = robotUrdf(spec())
	const kinds = (x: string) => urdfStructureChecks(x).map((f) => f.message)
	assert.deepEqual(kinds(u), [])
	assert.match(kinds(u.replace('<link name="base_footprint"/>', '<link name="base_footprint"/>\n  <link name="stray_link"/>')).join(), /2 root links \(base_footprint, stray_link\)/)
	assert.match(kinds(u.replace('<parent link="base_link"/>', '<parent link="base_lnk"/>')).join(), /parent link base_lnk isn't defined/)
	const bad = u.replace(/(<link name="left_wheel_link">[\s\S]*?)<mass value="[^"]+"\/>/, '$1<mass value="0"/>')
	assert.match(kinds(bad).join(), /link left_wheel_link has mass 0/)
	const tri = u.replace(/(<link name="left_wheel_link">[\s\S]*?<inertia )[^/]*\/>/, '$1ixx="1" ixy="0" ixz="0" iyy="1" iyz="0" izz="3"/>')
	assert.match(kinds(tri).join(), /left_wheel_link's principal moments .* break the triangle inequality/)
})

test("a built chassis whose ROS package a simulator would refuse is a ros-package violation in every build", async () => {
	const { checkConsistency } = await import("../src/contract/consistency.ts")
	const s = spec()
	const dir = tempDir()
	writeFileSync(join(dir, "spec.json"), JSON.stringify(s))
	const pkg = writeRosPackage(join(dir, "ros", "src"), s, { robot: "rover", revision: 9 })
	const c = rover()
	const chassis = { chassis: { ok: true, revision: 9, dir, files: [], mounts: null } } as never
	assert.ok(!checkConsistency(c, chassis).some((v) => v.kind === "ros-package"), "the generated package is clean")
	const u = join(pkg, "urdf", "rover.mock.urdf")
	writeFileSync(u, readFileSync(u, "utf8").replace(/<mass value="([\d.]+)"\/>/, '<mass value="-1"/>'))
	const v = checkConsistency(c, chassis).filter((x) => x.kind === "ros-package")
	assert.ok(v.some((x) => /has mass -1/.test(x.message)), JSON.stringify(v))
	assert.deepEqual(v[0].affects, ["mechanics"])
})

// ROS on the real robot (docs/ros.md): with encoders the bridge reads the firmware's counts (rad_per_count from the
// counts the firmware itself counts) and the controller closes its odometry on them; with an IMU its heading is a
// ros2_control sensor published by imu_sensor_broadcaster; the launch takes the real robot's serial device.
test("encoders and an IMU reach ROS: the bridge's count scale, closed-loop odometry, the IMU sensor and its broadcaster", () => {
	const s = { ...spec(), motor: { ...spec().motor, encoderCountsPerRev: 1400 }, imu: { noiseDegPerSqrtS: 0.005, biasDegPerS: 0.05 } }
	const u = robotUrdf(s, { name: "rover", hardware: "bringup" })
	assert.match(u, new RegExp(`<param name="rad_per_count">${Number(((2 * Math.PI) / 1400).toPrecision(8))}</param>`))
	assert.match(u, /<sensor name="imu">[\s\S]*orientation\.w[\s\S]*linear_acceleration\.z[\s\S]*<\/sensor>/)
	assert.match(u, /<joint name="imu_joint" type="fixed">/)
	assert.match(robotUrdf(s, { hardware: "mock" }), /<state_interface name="orientation\.w"><param name="initial_value">1\.0<\/param>/)
	assert.deepEqual(rosUrdfChecks(s, u), [])
	const y = controllersYaml(s)
	assert.match(y, /open_loop: false/)
	assert.match(y, /imu_sensor_broadcaster:\n {6}type: imu_sensor_broadcaster\/IMUSensorBroadcaster/)
	assert.match(y, /static_covariance_orientation: \[1\.0e6, [^\]]*, 7\.6154355e-7\]/)
	assert.deepEqual(rosControllerChecks(s, y), [])
	const pkg = writeRosPackage(tempDir(), s, { robot: "rover" })
	assert.match(readFileSync(join(pkg, "package.xml"), "utf8"), /<exec_depend>imu_sensor_broadcaster<\/exec_depend>/)
	const launch = readFileSync(join(pkg, "launch", "bringup.launch.py"), "utf8")
	assert.match(launch, /arguments=\["imu_sensor_broadcaster"\]/)
	assert.match(launch, /DeclareLaunchArgument\("port"/)
	assert.deepEqual(rosPackageChecks(s, pkg), [])
	// Without either, nothing of them is written.
	const plain = robotUrdf(spec(), { hardware: "bringup" })
	assert.doesNotMatch(plain, /rad_per_count|name="imu"/)
	assert.doesNotMatch(controllersYaml(spec()), /imu/)
})

// The launch's port:= replaces the URDF's console with the robot's serial device, the rest of the file untouched.
test("the launch's port argument points the bridge at a real robot's serial device", async () => {
	const { execFileSync } = await import("node:child_process")
	const pkg = writeRosPackage(tempDir(), spec(), { robot: "rover" })
	const launch = readFileSync(join(pkg, "launch", "bringup.launch.py"), "utf8")
	const line = /description = re\.sub\((.*)\)/.exec(launch)![1]
	const urdf = robotUrdf(spec(), { name: "rover", hardware: "bringup" })
	const py = `import re, sys\ndescription = sys.stdin.read()\nport = "/dev/ttyACM0"\ndescription = re.sub(${line})\nsys.stdout.write(description)`
	const out = execFileSync("python3", ["-c", py], { input: urdf, encoding: "utf8" })
	assert.match(out, /<param name="port">\/dev\/ttyACM0<\/param>/)
	assert.equal(out.replace("/dev/ttyACM0", "tcp:127.0.0.1:5555"), urdf)
})

// A skid-steer robot has four wheel joints; the bridge refused anything but two (on_init: "expected 2 wheel joints").
test("the hardware bridge takes a skid-steer robot's four wheel joints and the firmware's measured fields", () => {
	const src = readFileSync(join(import.meta.dirname, "..", "templates", "ros", "bringup_hardware", "src", "bringup_system.cpp"), "utf8")
	assert.match(src, /info\.joints\.size\(\) != 2 && info\.joints\.size\(\) != 4/)
	assert.match(src, /p\[0\] == 'E'/)
	assert.match(src, /p\[0\] == 'H'/)
	const fw = readFileSync(join(import.meta.dirname, "..", "templates", "fw-rover", "src", "main.cpp"), "utf8")
	assert.match(fw, /Serial\.printf\(" E %ld %ld"/)
	assert.match(fw, /Serial\.printf\(" H %ld"/)
})
