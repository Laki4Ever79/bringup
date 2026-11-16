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

import { bagStats, diagnose, i2cRise } from "../src/ros/diagnose.ts"

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
