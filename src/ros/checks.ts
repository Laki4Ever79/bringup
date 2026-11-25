import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { rosPackageName } from "./package.ts"
import type { ChassisSpec } from "../tools/chassis.ts"
import { bodyOf, maxWheelRadS } from "./urdf.ts"

// ROS settings against the hardware (docs/ros.md): a robot's ROS package is generated from its design, but people edit
// it (a hand-tuned YAML, a URDF from elsewhere). These checks read the package's files and compare every number that
// has a hardware truth behind it with the design: the wheels, the speed limits, the control rate, the mass. Plain code,
// like the mechanics checks; each finding names the file, the number and the design value it should be.

export interface RosFinding {
	kind: "ros-wheel-geometry" | "ros-limits" | "ros-rate" | "ros-inertials" | "ros-hardware" | "ros-urdf"
	message: string
}

// A YAML scalar by its key (the generated controllers.yaml is flat enough for this; a key missing gives undefined).
function yamlNumber(text: string, key: string): number | undefined {
	const m = new RegExp(`^\\s*${key.replace(/\./g, "\\.")}\\s*:\\s*(-?[\\d.eE+-]+)`, "m").exec(text)
	return m ? Number(m[1]) : undefined
}

const near = (a: number, b: number, rel = 0.01, abs = 1e-4) => Math.abs(a - b) <= Math.max(abs, rel * Math.abs(b))

export function rosControllerChecks(spec: ChassisSpec, yaml: string, file = "config/controllers.yaml"): RosFinding[] {
	const out: RosFinding[] = []
	const sep = yamlNumber(yaml, "wheel_separation"), rad = yamlNumber(yaml, "wheel_radius")
	const track = spec.drive.trackMm / 1000, radius = spec.drive.wheelDiameterMm / 2000
	if (sep === undefined || !near(sep, track)) out.push({ kind: "ros-wheel-geometry", message: `${file}: wheel_separation is ${sep ?? "missing"}, the design's track is ${track} m (drive.trackMm): odometry and turns would be off by ${sep ? Math.round(Math.abs(sep / track - 1) * 100) : 100} %` })
	if (rad === undefined || !near(rad, radius)) out.push({ kind: "ros-wheel-geometry", message: `${file}: wheel_radius is ${rad ?? "missing"}, the design's wheel is ${radius} m (its catalog diameter / 2): every speed and distance would scale by ${rad ? (rad / radius).toFixed(2) : "?"}` })
	// The fastest the wheels can go: the motor's loaded speed at duty 1 on the cell.
	const topMps = maxWheelRadS(spec) * radius
	const vmax = yamlNumber(yaml, "linear.x.max_velocity")
	if (vmax !== undefined && vmax > topMps * 1.001) out.push({ kind: "ros-limits", message: `${file}: linear.x.max_velocity is ${vmax} m/s, but the motors reach ${topMps.toFixed(3)} m/s loaded on the cell's ${spec.pack.nominalV} V: the controller would ask for speed the hardware can't give` })
	const wmax = yamlNumber(yaml, "angular.z.max_velocity")
	if (wmax !== undefined && wmax > ((2 * topMps) / track) * 1.001) out.push({ kind: "ros-limits", message: `${file}: angular.z.max_velocity is ${wmax} rad/s, over the ${((2 * topMps) / track).toFixed(2)} rad/s the wheels give at full speed in opposite directions` })
	// The controller can't run usefully faster than the firmware's control tick: each command waits for the next tick.
	const rate = yamlNumber(yaml, "update_rate")
	const tickHz = 1000 / spec.sensor.updateMs
	if (rate !== undefined && rate > tickHz * 1.05) out.push({ kind: "ros-rate", message: `${file}: update_rate is ${rate} Hz, but the firmware's control tick is ${tickHz.toFixed(0)} Hz (the sensor's ${spec.sensor.updateMs} ms): ${Math.round(rate / tickHz)} commands per tick, all but the last unused` })
	return out
}

// What check_urdf (liburdfdom) checks, in plain code so it runs in every build without the ROS image: the links form
// one tree (unique names, every joint's parent and child a link, no link a child twice, one root); and what a physics
// engine needs of each inertial (text-to-cad's inertial sanity gates): a positive mass, positive principal moments that
// satisfy the triangle inequality (each at most the sum of the other two), a positive-definite tensor. A bad one makes
// Gazebo or MuJoCo explode or silently drop the link.
export function urdfStructureChecks(urdf: string, file = "urdf/robot.urdf"): RosFinding[] {
	const out: RosFinding[] = []
	const links = [...urdf.matchAll(/<link name="([^"]+)"/g)].map((m) => m[1])
	const dup = links.filter((l, i) => links.indexOf(l) !== i)
	if (dup.length) out.push({ kind: "ros-urdf", message: `${file}: link names used twice: ${[...new Set(dup)].join(", ")}` })
	const joints = [...urdf.matchAll(/<joint name="([^"]+)"[^>]*>([\s\S]*?)<\/joint>/g)]
		.map((m) => ({ name: m[1], parent: /<parent link="([^"]+)"/.exec(m[2])?.[1], child: /<child link="([^"]+)"/.exec(m[2])?.[1] }))
		.filter((j) => j.parent !== undefined || j.child !== undefined) // ros2_control's <joint> entries have neither
	const children = new Set<string>()
	for (const j of joints) {
		for (const [role, l] of [["parent", j.parent], ["child", j.child]] as const) if (!l || !links.includes(l)) out.push({ kind: "ros-urdf", message: `${file}: joint ${j.name}'s ${role} ${l ? `link ${l} isn't defined` : "is missing"}` })
		if (j.child && children.has(j.child)) out.push({ kind: "ros-urdf", message: `${file}: link ${j.child} is the child of two joints: not a tree` })
		if (j.child) children.add(j.child)
	}
	const roots = links.filter((l) => !children.has(l))
	if (links.length && roots.length !== 1) out.push({ kind: "ros-urdf", message: `${file}: ${roots.length} root links (${roots.join(", ") || "none"}); a URDF has exactly one` })
	for (const m of urdf.matchAll(/<link name="([^"]+)">([\s\S]*?)<\/link>/g)) {
		const body = m[2]
		if (!body.includes("<inertial>")) continue
		const mass = Number(/<mass value="([^"]+)"/.exec(body)?.[1])
		const n = (k: string) => Number(new RegExp(`${k}="([^"]+)"`).exec(/<inertia [^>]*\/>/.exec(body)?.[0] ?? "")?.[1] ?? NaN)
		const [xx, yy, zz, xy, xz, yz] = ["ixx", "iyy", "izz", "ixy", "ixz", "iyz"].map(n)
		if (!(mass > 0)) out.push({ kind: "ros-inertials", message: `${file}: link ${m[1]} has mass ${mass}: it must be positive` })
		const eig = symEigen3(xx, yy, zz, xy, xz, yz)
		const tol = 1e-12
		if (!eig || eig.some((e) => !(e > tol))) out.push({ kind: "ros-inertials", message: `${file}: link ${m[1]}'s inertia isn't positive definite (principal moments ${eig ? eig.map((e) => e.toExponential(3)).join(", ") : "unreadable"})` })
		else if (eig[0] + eig[1] < eig[2] * (1 - 1e-6)) out.push({ kind: "ros-inertials", message: `${file}: link ${m[1]}'s principal moments ${eig.map((e) => e.toExponential(3)).join(", ")} break the triangle inequality (no real body has them)` })
	}
	return out
}

// The eigenvalues of a symmetric 3×3 matrix, ascending (closed form; Smith 1961). Null for a non-finite entry.
export function symEigen3(a: number, b: number, c: number, d: number, e: number, f: number): [number, number, number] | null {
	if (![a, b, c, d, e, f].every(Number.isFinite)) return null
	const p1 = d * d + e * e + f * f
	if (p1 === 0) return [a, b, c].sort((x, y) => x - y) as [number, number, number]
	const q = (a + b + c) / 3
	const p2 = (a - q) ** 2 + (b - q) ** 2 + (c - q) ** 2 + 2 * p1
	const p = Math.sqrt(p2 / 6)
	const B = [[(a - q) / p, d / p, e / p], [d / p, (b - q) / p, f / p], [e / p, f / p, (c - q) / p]]
	const det = B[0][0] * (B[1][1] * B[2][2] - B[1][2] * B[2][1]) - B[0][1] * (B[1][0] * B[2][2] - B[1][2] * B[2][0]) + B[0][2] * (B[1][0] * B[2][1] - B[1][1] * B[2][0])
	const r = Math.min(1, Math.max(-1, det / 2))
	const phi = Math.acos(r) / 3
	const e1 = q + 2 * p * Math.cos(phi), e3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3)
	return [e3, 3 * q - e1 - e3, e1].sort((x, y) => x - y) as [number, number, number]
}

// The URDF's total mass and its wheel joints against the design.
export function rosUrdfChecks(spec: ChassisSpec, urdf: string, file = "urdf/robot.urdf"): RosFinding[] {
	const out: RosFinding[] = [...urdfStructureChecks(urdf, file)]
	const masses = [...urdf.matchAll(/<mass value="([\d.eE+-]+)"/g)].map((m) => Number(m[1]))
	const total = masses.reduce((a, b) => a + b, 0)
	const want = spec.massG / 1000
	if (!near(total, want, 0.02)) out.push({ kind: "ros-inertials", message: `${file}: the links weigh ${total.toFixed(3)} kg together, the design ${want.toFixed(3)} kg (the mechanics checks' mass): a controller tuned on it would misjudge acceleration and braking` })
	for (const side of ["left", "right"]) if (!new RegExp(`<joint name="${side}_wheel_joint" type="continuous">`).test(urdf)) out.push({ kind: "ros-wheel-geometry", message: `${file}: no continuous ${side}_wheel_joint, which the diff-drive controller and the hardware drive` })
	const b = bodyOf(spec)
	const axle = new RegExp(`<joint name="left_wheel_joint"[\\s\\S]*?<origin xyz="([-\\d.eE+]+) ([-\\d.eE+]+) ([-\\d.eE+]+)"`).exec(urdf)
	if (axle && (!near(Number(axle[2]) * 2, spec.drive.trackMm / 1000) || !near(Number(axle[3]), b.r)))
		out.push({ kind: "ros-wheel-geometry", message: `${file}: the left wheel sits at y ${axle[2]}, z ${axle[3]} m; the design puts it at y ${spec.drive.trackMm / 2000}, z ${b.r} m (half the track, the wheel's radius)` })
	// base_link at the drive's pivot: diff_drive_controller's odometry moves that point, so any other origin drifts from
	// the robot's real position in every turn (63 mm after a 1.55 rad turn, 23 Nov 2026).
	const pivotX = b.skid ? (b.axleX - b.casterX) / 2 : 0
	if (axle && Math.abs(Number(axle[1]) - pivotX) > 0.001)
		out.push({ kind: "ros-wheel-geometry", message: `${file}: the left wheel sits ${axle[1]} m ahead of base_link; the odometry moves the drive's pivot, so base_link must sit there (the wheel ${pivotX.toFixed(4)} m ahead)` })
	return out
}

// Every check over a package folder (the generated layout: config/controllers.yaml, urdf/<robot>.<hardware>.urdf).
export function rosPackageChecks(spec: ChassisSpec, pkgDir: string, robot = "rover"): RosFinding[] {
	const out: RosFinding[] = []
	const yaml = `${pkgDir}/config/controllers.yaml`
	if (existsSync(yaml)) out.push(...rosControllerChecks(spec, readFileSync(yaml, "utf8")))
	for (const hw of ["mock", "bringup"]) {
		const urdf = `${pkgDir}/urdf/${robot}.${hw}.urdf`
		if (existsSync(urdf)) out.push(...rosUrdfChecks(spec, readFileSync(urdf, "utf8"), `urdf/${robot}.${hw}.urdf`))
	}
	return out
}

// The ROS package built with a chassis (tools/chassis.ts buildChassis: <dir>/ros/src/<pkg>), checked against the spec
// it was built from (<dir>/spec.json), in every build: before 19 Nov 2026 these checks ran only in the test suite, so a
// generated URDF that a robot_state_publisher or a simulator would refuse went unnoticed until the post-run ROS test
// (when the ROS image was there at all). Nothing to check when the package or the spec isn't there.
export function rosBuiltChecks(chassisDir: string, robot = "rover"): RosFinding[] {
	const specPath = join(chassisDir, "spec.json")
	const pkg = join(chassisDir, "ros", "src", rosPackageName(robot))
	if (!existsSync(specPath) || !existsSync(pkg)) return []
	return rosPackageChecks(JSON.parse(readFileSync(specPath, "utf8")) as ChassisSpec, pkg, robot)
}
