import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chassisSpec } from "../src/tools/chassis.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import { controllersYaml, driveLimits, pivotX } from "../src/ros/urdf.ts"
import { arenaMap, footprint, nav2Params, navGoalScript, navigationLaunch, type Arena } from "../src/ros/nav2.ts"
import { navResult } from "../src/ros/run.ts"
import { writeRosPackage } from "../src/ros/package.ts"
import { arenaOf } from "../src/ros/cli.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

// ROS step 2 (docs/ros.md): Nav2's settings come from the design, and a competition robot gets its table as the map.

const spec = () => chassisSpec({ revision: 9, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) } as ContractSnapshot)!
const TABLE: Arena = { sizeMm: [3000, 2000], wallMm: 22, source: "D.2" }
const python = existsSync(".venv/bin/python") ? ".venv/bin/python" : "python3"
const yamlOk = (text: string) => spawnSync(python, ["-c", "import sys, yaml; yaml.safe_load(sys.stdin)"], { input: text }).status === 0

test("the footprint is the plate and the wheels seen from above, from the pivot: wheels past a narrow plate widen it", () => {
	const s = spec()
	s.plate.widthMm = s.drive.trackMm - 40 // the Eurobot rover's case: its wheels stand out past the plate
	const fp = footprint(s)
	const ys = fp.map(([, y]) => y), xs = fp.map(([x]) => x)
	assert.equal(Math.max(...ys), (s.drive.trackMm / 2 + s.drive.wheelWidthMm / 2) / 1000, "the wheel's outer face, not the plate's edge")
	assert.ok(Math.abs(Math.max(...xs) - Math.max(s.plate.lengthMm / 2000, (s.drive.axleXMm + s.drive.wheelDiameterMm / 2) / 1000) + pivotX(s)) < 1e-9, "x from the pivot (base_link), not the plate's centre")
	assert.ok(Math.min(...xs) < 0 && Math.max(...xs) > 0)
})

test("Nav2 asks for no more than the drive gives: the controller's speed, turn acceleration and the firmware's tick", () => {
	const s = spec()
	const y = nav2Params(s)
	const lim = driveLimits(s)
	assert.match(y, new RegExp(`desired_linear_vel: ${Number(lim.vmax.toFixed(4))}`))
	assert.match(controllersYaml(s), new RegExp(`linear.x.max_velocity: ${Number(lim.vmax.toFixed(6))}`), "the same figure the diff-drive controller holds the robot to")
	assert.match(y, new RegExp(`max_angular_accel: ${Number(lim.alphaMax.toFixed(4))}`))
	assert.match(y, /enable_stamped_cmd_vel: true/)
	assert.match(y, /topics: \["\/range_sensor_broadcaster\/range"\]/)
	assert.match(y, /odom_topic: \/diff_drive_controller\/odom/)
	assert.ok(yamlOk(y), "valid YAML")
})

test("without a table Nav2 plans in a window around the robot; with one, on the table's map", () => {
	const s = spec()
	const free = nav2Params(s), table = nav2Params(s, { arena: TABLE })
	assert.match(free, /global_frame: odom[\s\S]*rolling_window: true/)
	assert.doesNotMatch(free, /StaticLayer|map_server/)
	assert.match(table, /global_costmap:[\s\S]*global_frame: map[\s\S]*nav2_costmap_2d::StaticLayer/)
	assert.match(table, /map_server:/)
	assert.ok(yamlOk(table))
	const launch = navigationLaunch("rover_bringup", { arena: TABLE })
	assert.match(launch, /"node_names": \["map_server","controller_server","planner_server","behavior_server","bt_navigator"\]/)
	assert.match(launch, /DeclareLaunchArgument\("start_y", default_value="1"\)/, "the table's middle row by default")
	assert.equal(spawnSync(python, ["-c", "import ast, sys; ast.parse(sys.stdin.read())"], { input: launch }).status, 0, "the launch file parses")
})

test("the table's map: 1 cm cells, its walls occupied, the playing area free, the corner at the map's origin", () => {
	const { pgm, yaml } = arenaMap(TABLE)
	const head = pgm.subarray(0, 64).toString("latin1").split("\n")
	assert.equal(head[0], "P5")
	const [w, h] = head[2].split(" ").map(Number)
	assert.deepEqual([w, h], [304, 204])
	const px = pgm.subarray(pgm.length - w * h)
	assert.equal(px[0], 0, "the wall's corner")
	assert.equal(px[1 * w + 1], 0, "inside the 22 mm wall (two cells)")
	assert.equal(px[2 * w + 2], 254, "the table starts past it")
	assert.equal(px[100 * w + 150], 254, "the table")
	assert.match(yaml, /origin: \[-0.022, -0.022, 0.0\]/)
})

test("a Eurobot design's table comes from its cited rules; the package carries Nav2 and the map", () => {
	const contract = { revision: 4, values: { motion: { rules: "eurobot-2026" } } } as unknown as ContractSnapshot
	const arena = arenaOf(process.cwd(), contract)!
	assert.deepEqual([arena.sizeMm, arena.wallMm], [[3000, 2000], 22])
	assert.match(arena.source, /D\.2 Playing area, p\. 7/)
	assert.equal(arenaOf(process.cwd(), { revision: 1, values: { motion: {} } } as unknown as ContractSnapshot), undefined)
	const dir = mkdtempSync(join(tmpdir(), "nav2-pkg-"))
	const root = writeRosPackage(dir, spec(), { robot: "rover", revision: 4, arena })
	for (const f of ["config/nav2.yaml", "launch/navigation.launch.py", "maps/arena.pgm", "maps/arena.yaml", "test/nav_goal.py"]) assert.ok(existsSync(join(root, f)), f)
	assert.match(readFileSync(join(root, "launch", "bringup.launch.py"), "utf8"), /DeclareLaunchArgument\("nav"[\s\S]*IfCondition\(LaunchConfiguration\("nav"\)\)/)
	assert.match(readFileSync(join(root, "package.xml"), "utf8"), /<exec_depend>nav2_map_server<\/exec_depend>/)
	assert.match(readFileSync(join(root, "CMakeLists.txt"), "utf8"), /install\(DIRECTORY urdf config launch test maps/)
})

test("the Nav2 goal script parses and carries the design's start, goal and time budget", () => {
	const s = spec()
	const py = navGoalScript(s, [0.5, 1], [1.2, 1.3])
	assert.equal(spawnSync(python, ["-c", "import ast, sys; ast.parse(sys.stdin.read())"], { input: py }).status, 0)
	assert.match(py, /START = \(0\.5, 1\)\nGOAL = \(1\.2, 1\.3\)/)
	const budget = (3 * Math.hypot(0.7, 0.3)) / driveLimits(s).vmax + 15
	assert.match(py, new RegExp(`BUDGET_S = ${Number(budget.toFixed(4))}`))
})

test("the goal's checks are read back, and in simulation the robot's real end is judged against the goal", () => {
	const dir = mkdtempSync(join(tmpdir(), "nav-res-"))
	const res = join(dir, "nav-qemu.json"), traj = join(dir, "trajectory.json")
	writeFileSync(res, JSON.stringify({ pass: true, checks: [{ name: "Nav2 reports the goal reached", pass: true, measured: 4, expected: 4 }], start: [0.5, 1], goal: [1.2, 1.3], end: [1.19, 1.31] }))
	// The simulated axle starts at world (0.075, 0) and ends 0.69 m ahead and 0.31 m left of it.
	writeFileSync(traj, JSON.stringify([[0, 0, 0, 0, 0, 0, 0, 0.075, 0], [30, 0.6, 0.3, 0, 0, 0, 0, 0.765, 0.31]]))
	const checks = navResult(res, traj)
	assert.deepEqual(checks.map((c) => c.name), ["nav: Nav2 reports the goal reached", "nav: the simulated robot is at the goal", "nav: odometry vs the simulation (information)"])
	assert.ok(checks[1].pass)
	assert.equal(checks[1].measured, Number(Math.hypot(0.01, 0.01).toFixed(4)))
	assert.equal(navResult(join(dir, "missing.json"))[0].pass, false, "no result file is a failure, never a pass")
})
