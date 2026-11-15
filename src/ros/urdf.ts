import type { ChassisSpec } from "../tools/chassis.ts"

// The robot's ROS 2 description (URDF) from the chassis spec, the same numbers the MuJoCo model (py/mech/model.py)
// and the mechanics checks use, in ROS units (REP-103: metres, kilograms, x forward, y left, z up). Frames (REP-105):
// base_footprint on the floor under the plate's centre, base_link at the same point (the spec's own origin, z from the
// floor), a wheel link on each continuous joint at the axle, the caster, the range sensor and each board.
//
// Inertias are boxes and cylinders from the spec's sizes and masses: ESTIMATES, said so in the file. The ros2_control
// block names the hardware: "mock" (mock_components/GenericSystem: commands mirrored back as states, for wiring and
// limits) or "bringup" (the bridge to the robot's own firmware over its serial frames, real or in QEMU).

export type RosHardware = "mock" | "bringup"
export const HARDWARE_PLUGIN: Record<RosHardware, string> = {
	mock: "mock_components/GenericSystem",
	bringup: "bringup_hardware/BringupSystem",
}

const mm = (v: number) => v / 1000
const f = (v: number) => Number(v.toFixed(6)).toString()
const xyz = (x: number, y: number, z: number) => `${f(x)} ${f(y)} ${f(z)}`

const boxInertia = (m: number, x: number, y: number, z: number) => ({ ixx: (m * (y * y + z * z)) / 12, iyy: (m * (x * x + z * z)) / 12, izz: (m * (x * x + y * y)) / 12 })
// A wheel spinning about its own y axis (the joint axis): a solid cylinder of radius r and width w.
const wheelInertia = (m: number, r: number, w: number) => ({ ixx: (m * (3 * r * r + w * w)) / 12, iyy: (m * r * r) / 2, izz: (m * (3 * r * r + w * w)) / 12 })
const sphereInertia = (m: number, r: number) => ({ ixx: (2 * m * r * r) / 5, iyy: (2 * m * r * r) / 5, izz: (2 * m * r * r) / 5 })

function inertial(massKg: number, at: [number, number, number], i: { ixx: number; iyy: number; izz: number }): string {
	return `    <inertial>
      <origin xyz="${xyz(...at)}" rpy="0 0 0"/>
      <mass value="${f(massKg)}"/>
      <inertia ixx="${f(i.ixx)}" ixy="0" ixz="0" iyy="${f(i.iyy)}" iyz="0" izz="${f(i.izz)}"/>
    </inertial>`
}

// The wheels' and caster's centres and the body's own mass and centre of mass (the whole rover's less theirs), as
// model.py computes them, so the URDF's total mass and centre of mass equal the spec's.
export function bodyOf(spec: ChassisSpec) {
	const d = spec.drive
	const r = mm(d.wheelDiameterMm) / 2
	const casterR = mm(spec.caster.wheelMm) / 2
	const total = spec.massG / 1000
	const wheelKg = spec.wheelMassG / 1000
	const casterKg = spec.casterMassG / 1000
	const bodyKg = Math.max(0.01, total - 2 * wheelKg - casterKg)
	const axleX = mm(d.axleXMm), casterX = mm(d.axleXMm - d.wheelbaseMm)
	const whole = spec.com.map(mm) as [number, number, number]
	const parts: [number, [number, number, number]][] = [[2 * wheelKg, [axleX, 0, r]], [casterKg, [casterX, 0, casterR]]]
	const com = [0, 1, 2].map((i) => (whole[i] * total - parts.reduce((t, [m, at]) => t + m * at[i], 0)) / bodyKg) as [number, number, number]
	return { r, casterR, total, wheelKg, casterKg, bodyKg, axleX, casterX, com }
}

// The wheel's speed at duty 1: the motor's no-load speed on the cell's nominal voltage, loaded (0.8, the mechanics
// checks' own derate), in rad/s. The bridge turns a velocity command into a duty with it.
export function maxWheelRadS(spec: ChassisSpec): number {
	return ((spec.motor.noLoadRpm * spec.pack.nominalV) / spec.motor.ratedV) * 0.8 * ((2 * Math.PI) / 60)
}

export function robotUrdf(spec: ChassisSpec, opts: { name?: string; hardware?: RosHardware; port?: string } = {}): string {
	const name = opts.name ?? "bringup_robot"
	const hw = opts.hardware ?? "mock"
	const d = spec.drive, p = spec.plate
	const b = bodyOf(spec)
	const L = mm(p.lengthMm), W = mm(p.widthMm), t = mm(p.thicknessMm)
	const plateZ = mm(p.clearanceMm) + t / 2
	const ww = mm(d.wheelWidthMm), track = mm(d.trackMm)
	const s = spec.sensor
	const wheel = (side: "left" | "right", sign: 1 | -1) => `  <link name="${side}_wheel_link">
    <visual>
      <origin xyz="0 0 0" rpy="1.570796 0 0"/>
      <geometry><cylinder radius="${f(b.r)}" length="${f(ww)}"/></geometry>
    </visual>
    <collision>
      <origin xyz="0 0 0" rpy="1.570796 0 0"/>
      <geometry><cylinder radius="${f(b.r)}" length="${f(ww)}"/></geometry>
    </collision>
${inertial(b.wheelKg, [0, 0, 0], wheelInertia(b.wheelKg, b.r, ww))}
  </link>
  <joint name="${side}_wheel_joint" type="continuous">
    <parent link="base_link"/>
    <child link="${side}_wheel_link"/>
    <origin xyz="${xyz(b.axleX, (sign * track) / 2, b.r)}" rpy="0 0 0"/>
    <axis xyz="0 1 0"/>
  </joint>`
	const boards = spec.boards
		.map(
			(bd) => `  <link name="board_${bd.name}_link">
    <visual>
      <geometry><box size="${xyz(mm(bd.widthMm), mm(bd.heightMm), 0.0016)}"/></geometry>
    </visual>
  </link>
  <joint name="board_${bd.name}_joint" type="fixed">
    <parent link="base_link"/>
    <child link="board_${bd.name}_link"/>
    <origin xyz="${xyz(mm(bd.xMm), mm(bd.yMm), plateZ + t / 2 + mm(spec.standoffMm))}" rpy="0 0 ${f((bd.rotDeg * Math.PI) / 180)}"/>
  </joint>`,
		)
		.join("\n")
	const joints = ["left_wheel_joint", "right_wheel_joint"]
		.map(
			(j) => `    <joint name="${j}">
      <command_interface name="velocity"/>
      <state_interface name="position"/>
      <state_interface name="velocity"/>
    </joint>`,
		)
		.join("\n")
	return `<?xml version="1.0"?>
<!-- Generated by Bringup from the design contract (src/ros/urdf.ts). Do not edit: change the design instead.
     Masses and centres of mass are the mechanics checks' own; inertias are ESTIMATES (boxes and cylinders from the
     parts' sizes). Units per REP-103, frames per REP-105. -->
<robot name="${name}">
  <link name="base_footprint"/>
  <joint name="base_joint" type="fixed">
    <parent link="base_footprint"/>
    <child link="base_link"/>
    <origin xyz="0 0 0" rpy="0 0 0"/>
  </joint>
  <link name="base_link">
    <visual>
      <origin xyz="${xyz(0, 0, plateZ)}" rpy="0 0 0"/>
      <geometry><box size="${xyz(L, W, t)}"/></geometry>
    </visual>
    <collision>
      <origin xyz="${xyz(0, 0, plateZ)}" rpy="0 0 0"/>
      <geometry><box size="${xyz(L, W, t)}"/></geometry>
    </collision>
${inertial(b.bodyKg, b.com, boxInertia(b.bodyKg, L, W, 0.03))}
  </link>
${wheel("left", 1)}
${wheel("right", -1)}
  <link name="caster_link">
    <visual><geometry><sphere radius="${f(b.casterR)}"/></geometry></visual>
    <collision><geometry><sphere radius="${f(b.casterR)}"/></geometry></collision>
${inertial(b.casterKg, [0, 0, 0], sphereInertia(b.casterKg, b.casterR))}
  </link>
  <joint name="caster_joint" type="fixed">
    <parent link="base_link"/>
    <child link="caster_link"/>
    <origin xyz="${xyz(b.casterX, 0, b.casterR)}" rpy="0 0 0"/>
  </joint>
  <link name="range_sensor_link">
    <visual><geometry><box size="${xyz(mm(s.sizeMm[0]), mm(s.sizeMm[1]), mm(s.sizeMm[2]))}"/></geometry></visual>
  </link>
  <joint name="range_sensor_joint" type="fixed">
    <parent link="base_link"/>
    <child link="range_sensor_link"/>
    <origin xyz="${xyz(mm(s.xMm), mm(s.yMm), mm(s.zMm))}" rpy="0 0 0"/>
  </joint>
${boards}
  <ros2_control name="${name}_system" type="system">
    <hardware>
      <plugin>${HARDWARE_PLUGIN[hw]}</plugin>${
				hw === "bringup"
					? `
      <param name="port">${opts.port ?? "tcp:127.0.0.1:5555"}</param>
      <param name="max_wheel_rad_s">${f(maxWheelRadS(spec))}</param>`
					: ""
			}
    </hardware>
${joints}
    <sensor name="range_sensor">
      <state_interface name="range"/>
    </sensor>
  </ros2_control>
</robot>
`
}

// The diff_drive_controller's settings from the same design: wheel separation and radius from the drive, speed and
// acceleration limits from the brief and the motor. No encoders on today's rover: open loop, so odometry integrates
// the commands (the ros-odometry check blocks navigation on it).
export function controllersYaml(spec: ChassisSpec, opts: { updateRateHz?: number; encoders?: boolean } = {}): string {
	const d = spec.drive
	const r = mm(d.wheelDiameterMm) / 2
	const topMps = ((spec.motor.noLoadRpm * spec.pack.nominalV) / spec.motor.ratedV) * 0.8 * ((2 * Math.PI) / 60) * r
	const vmax = Math.min(topMps, Math.max(spec.speedMps, 0.05))
	const rate = opts.updateRateHz ?? Math.max(1, Math.round(1000 / spec.sensor.updateMs))
	return `# Generated by Bringup from the design contract (src/ros/urdf.ts). Do not edit: change the design instead.
controller_manager:
  ros__parameters:
    update_rate: ${rate}  # the firmware's control tick (${spec.sensor.updateMs} ms)
    joint_state_broadcaster:
      type: joint_state_broadcaster/JointStateBroadcaster
    diff_drive_controller:
      type: diff_drive_controller/DiffDriveController
    range_sensor_broadcaster:
      type: range_sensor_broadcaster/RangeSensorBroadcaster

diff_drive_controller:
  ros__parameters:
    left_wheel_names: ["left_wheel_joint"]
    right_wheel_names: ["right_wheel_joint"]
    wheel_separation: ${f(mm(d.trackMm))}  # drive.trackMm
    wheel_radius: ${f(r)}  # the wheel's catalog diameter / 2
    open_loop: ${opts.encoders ? "false" : "true"}  # ${opts.encoders ? "encoders on both wheels" : "no wheel encoders: odometry is the integrated command"}
    base_frame_id: base_footprint
    odom_frame_id: odom
    publish_rate: ${rate}.0
    enable_odom_tf: true
    cmd_vel_timeout: 0.5
    linear.x.max_velocity: ${f(vmax)}  # the brief's speed, within the motor's loaded top speed (${f(topMps)} m/s)
    linear.x.min_velocity: ${f(-vmax)}
    angular.z.max_velocity: ${f((2 * vmax) / mm(d.trackMm))}  # wheels at full speed in opposite directions
    angular.z.min_velocity: ${f((-2 * vmax) / mm(d.trackMm))}

range_sensor_broadcaster:
  ros__parameters:
    sensor_name: range_sensor
    frame_id: range_sensor_link
    radiation_type: 1  # infrared (the time-of-flight sensor's laser)
    field_of_view: ${f(((spec.sensor as { fovDeg?: number }).fovDeg ?? 25) * Math.PI / 180)}
    min_range: 0.03
    max_range: ${f(mm(spec.sensor.rangeMm))}  # the sensor's datasheet range
`
}
