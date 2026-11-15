import { existsSync, readFileSync } from "node:fs"
import type { ChassisSpec } from "../tools/chassis.ts"
import { bodyOf, maxWheelRadS } from "./urdf.ts"

// ROS settings against the hardware (docs/ros.md): a robot's ROS package is generated from its design, but people edit
// it (a hand-tuned YAML, a URDF from elsewhere). These checks read the package's files and compare every number that
// has a hardware truth behind it with the design: the wheels, the speed limits, the control rate, the mass. Plain code,
// like the mechanics checks; each finding names the file, the number and the design value it should be.

export interface RosFinding {
	kind: "ros-wheel-geometry" | "ros-limits" | "ros-rate" | "ros-inertials" | "ros-hardware"
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

// The URDF's total mass and its wheel joints against the design.
export function rosUrdfChecks(spec: ChassisSpec, urdf: string, file = "urdf/robot.urdf"): RosFinding[] {
	const out: RosFinding[] = []
	const masses = [...urdf.matchAll(/<mass value="([\d.eE+-]+)"/g)].map((m) => Number(m[1]))
	const total = masses.reduce((a, b) => a + b, 0)
	const want = spec.massG / 1000
	if (!near(total, want, 0.02)) out.push({ kind: "ros-inertials", message: `${file}: the links weigh ${total.toFixed(3)} kg together, the design ${want.toFixed(3)} kg (the mechanics checks' mass): a controller tuned on it would misjudge acceleration and braking` })
	for (const side of ["left", "right"]) if (!new RegExp(`<joint name="${side}_wheel_joint" type="continuous">`).test(urdf)) out.push({ kind: "ros-wheel-geometry", message: `${file}: no continuous ${side}_wheel_joint, which the diff-drive controller and the hardware drive` })
	const b = bodyOf(spec)
	const axle = new RegExp(`<joint name="left_wheel_joint"[\\s\\S]*?<origin xyz="([-\\d.eE+]+) ([-\\d.eE+]+) ([-\\d.eE+]+)"`).exec(urdf)
	if (axle && (!near(Number(axle[2]) * 2, spec.drive.trackMm / 1000) || !near(Number(axle[3]), b.r)))
		out.push({ kind: "ros-wheel-geometry", message: `${file}: the left wheel sits at y ${axle[2]}, z ${axle[3]} m; the design puts it at y ${spec.drive.trackMm / 2000}, z ${b.r} m (half the track, the wheel's radius)` })
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
