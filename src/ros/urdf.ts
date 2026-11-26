import type { ChassisSpec } from "../tools/chassis.ts"
import { drivenDecel, onWheelsShare } from "../mechanics/model.ts"
import { byMpn, servoAt, type MechCatalog } from "../mechanics/catalog.ts"
import { est } from "../mechanics/estimates.ts"
import { ARM_JOINTS, type ArmJointName, type ArmSpec } from "../arm/types.ts"

// The robot's ROS 2 description (URDF) from the chassis spec, the same numbers the MuJoCo model (py/mech/model.py)
// and the mechanics checks use, in ROS units (REP-103: metres, kilograms, x forward, y left, z up). Frames (REP-105):
// base_link at the drive's pivot (the axle's middle; a skid-steer's halfway between its axles), the point
// diff_drive_controller's odometry moves, and base_footprint on the floor under it (z from the floor); a wheel link on each continuous joint at the axle, the caster, the range sensor and each board.
//
// The body's inertia is composed from its parts (the spec's bodyParts: each a box of its own mass, centre and size,
// moved to the body's centre of mass by the parallel-axis rule, products of inertia included); the wheels are
// cylinders and the caster a sphere. Each part as a uniform box is still an ESTIMATE, said so in the file. The ros2_control
// block names the hardware: "mock" (mock_components/GenericSystem: commands mirrored back as states, for wiring and
// limits) or "bringup" (the bridge to the robot's own firmware over its serial frames, real or in QEMU).

export type RosHardware = "mock" | "bringup"
// The interfaces imu_sensor_broadcaster reads, in its order. The bridge fills the orientation and the yaw rate from the
// gyro's heading; the rest stay 0 and the broadcaster's covariance marks them unknown.
export const IMU_INTERFACES = ["orientation.x", "orientation.y", "orientation.z", "orientation.w", "angular_velocity.x", "angular_velocity.y", "angular_velocity.z", "linear_acceleration.x", "linear_acceleration.y", "linear_acceleration.z"]
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

type Inertia = { ixx: number; iyy: number; izz: number; ixy?: number; ixz?: number; iyz?: number }
// Eight significant digits: a small part's inertia (1e-7 kg·m²) must survive the print (f's six decimals would zero it).
const g = (v: number) => (v === 0 ? "0" : Number(v.toPrecision(8)).toString())
function inertial(massKg: number, at: [number, number, number], i: Inertia): string {
	return `    <inertial>
      <origin xyz="${xyz(...at)}" rpy="0 0 0"/>
      <mass value="${f(massKg)}"/>
      <inertia ixx="${g(i.ixx)}" ixy="${g(i.ixy ?? 0)}" ixz="${g(i.ixz ?? 0)}" iyy="${g(i.iyy)}" iyz="${g(i.iyz ?? 0)}" izz="${g(i.izz)}"/>
    </inertial>`
}

// The body's inertia tensor about its centre of mass `com` (metres, kg·m²): each part a uniform box about its own
// centre, moved by the parallel-axis rule (I += m(|d|²E − d dᵀ)). The URDF's products are the tensor's entries, so
// ixy = −Σ m dx dy. Null when the spec predates bodyParts (the caller falls back to one box).
export function bodyInertia(spec: ChassisSpec, com: [number, number, number]): Required<Inertia> | null {
	const parts = spec.bodyParts
	if (!parts?.length) return null
	const t = { ixx: 0, iyy: 0, izz: 0, ixy: 0, ixz: 0, iyz: 0 }
	for (const p of parts) {
		const m = p.massG / 1000
		if (!(m > 0)) continue
		const [sx, sy, sz] = p.sizeMm.map(mm)
		const own = boxInertia(m, sx, sy, sz)
		const [dx, dy, dz] = [0, 1, 2].map((i) => mm(p.atMm[i]) - com[i])
		t.ixx += own.ixx + m * (dy * dy + dz * dz)
		t.iyy += own.iyy + m * (dx * dx + dz * dz)
		t.izz += own.izz + m * (dx * dx + dy * dy)
		t.ixy -= m * dx * dy
		t.ixz -= m * dx * dz
		t.iyz -= m * dy * dz
	}
	return t
}

// The wheels' and caster's centres and the body's own mass and centre of mass (the whole rover's less theirs), as
// model.py computes them, so the URDF's total mass and centre of mass equal the spec's.
export function bodyOf(spec: ChassisSpec) {
	const d = spec.drive
	const r = mm(d.wheelDiameterMm) / 2
	// A skid-steer rover (drive kind "skid4") has no caster: a rear pair of wheels wheelbaseMm behind the front one.
	const skid = d.kind === "skid4"
	const casterR = mm(spec.caster?.wheelMm ?? 0) / 2
	const total = spec.massG / 1000
	const wheelKg = spec.wheelMassG / 1000
	const casterKg = spec.casterMassG / 1000
	const bodyKg = Math.max(0.01, total - (skid ? 4 : 2) * wheelKg - casterKg)
	const axleX = mm(d.axleXMm), casterX = mm(d.axleXMm - d.wheelbaseMm)
	const whole = spec.com.map(mm) as [number, number, number]
	const parts: [number, [number, number, number]][] = skid ? [[2 * wheelKg, [axleX, 0, r]], [2 * wheelKg, [casterX, 0, r]]] : [[2 * wheelKg, [axleX, 0, r]], [casterKg, [casterX, 0, casterR]]]
	const com = [0, 1, 2].map((i) => (whole[i] * total - parts.reduce((t, [m, at]) => t + m * at[i], 0)) / bodyKg) as [number, number, number]
	return { r, casterR, total, wheelKg, casterKg, bodyKg, axleX, casterX, com, skid }
}

// The wheel's speed at duty 1: the motor's no-load speed on the cell's nominal voltage, loaded (0.8, the mechanics
// checks' own derate), in rad/s. The bridge turns a velocity command into a duty with it.
export function maxWheelRadS(spec: ChassisSpec): number {
	return ((spec.motor.noLoadRpm * spec.pack.nominalV) / spec.motor.ratedV) * 0.8 * ((2 * Math.PI) / 60)
}

// base_link's x in the plate's frame (m): the drive's pivot, the axle's middle (a skid-steer's halfway between its axles).
export function pivotX(spec: ChassisSpec): number {
	const b = bodyOf(spec)
	return b.skid ? (b.axleX + b.casterX) / 2 : b.axleX
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
	// The spec's coordinates are from the plate's centre; the URDF's from the pivot. With base_link under the plate's
	// centre, the odometry (which moves the pivot) and the robot's drawn position drifted apart in every turn: 63 mm in x
	// after a 1.55 rad turn of the Eurobot rover, its axle 64 mm ahead of the centre (ROS step 1, 23 Nov 2026).
	const px = pivotX(spec)
	const X = (x: number) => x - px
	// A skid-steer rover's rear wheels: <side>_rear_wheel_link on <side>_rear_wheel_joint, at the rear axle.
	const wheel = (side: "left" | "right" | "left_rear" | "right_rear", sign: 1 | -1, x = b.axleX) => `  <link name="${side}_wheel_link">
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
    <origin xyz="${xyz(X(x), (sign * track) / 2, b.r)}" rpy="0 0 0"/>
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
    <origin xyz="${xyz(X(mm(bd.xMm)), mm(bd.yMm), plateZ + t / 2 + mm(spec.standoffMm))}" rpy="0 0 ${f((bd.rotDeg * Math.PI) / 180)}"/>
  </joint>`,
		)
		.join("\n")
	// The IMU's frame: on the board that carries it (the main board, else the first), aligned with the robot. The
	// firmware reports its heading already in the robot's frame (counter-clockwise about z), so no rotation here.
	const imuBoard = spec.boards.find((bd) => bd.name === "main") ?? spec.boards[0]
	const imuAt: [number, number, number] = imuBoard ? [X(mm(imuBoard.xMm)), mm(imuBoard.yMm), plateZ + t / 2 + mm(spec.standoffMm)] : [X(0), 0, plateZ]
	const imuLink = spec.imu
		? `
  <link name="imu_link"/>
  <joint name="imu_joint" type="fixed">
    <parent link="base_link"/>
    <child link="imu_link"/>
    <origin xyz="${xyz(...imuAt)}" rpy="0 0 0"/>
  </joint>`
		: ""
	const imuSensor = spec.imu
		? `
    <sensor name="imu">
${IMU_INTERFACES.map((i) => (i === "orientation.w" && hw === "mock" ? `      <state_interface name="${i}"><param name="initial_value">1.0</param></state_interface>` : `      <state_interface name="${i}"/>`)).join("\n")}
    </sensor>`
		: ""
	const cpr = spec.motor.encoderCountsPerRev
	const joints = ["left_wheel_joint", "right_wheel_joint", ...(b.skid ? ["left_rear_wheel_joint", "right_rear_wheel_joint"] : [])]
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
     Masses and centres of mass are the mechanics checks' own. The body's inertia is composed from its ${spec.bodyParts?.length ?? 0} parts
     (each a uniform box: an ESTIMATE), the wheels' and caster's are cylinders and a sphere. Units per REP-103, frames per REP-105. -->
<robot name="${name}">
  <link name="base_footprint"/>
  <joint name="base_joint" type="fixed">
    <parent link="base_footprint"/>
    <child link="base_link"/>
    <origin xyz="0 0 0" rpy="0 0 0"/>
  </joint>
  <link name="base_link">
    <visual>
      <origin xyz="${xyz(X(0), 0, plateZ)}" rpy="0 0 0"/>
      <geometry><box size="${xyz(L, W, t)}"/></geometry>
    </visual>
    <collision>
      <origin xyz="${xyz(X(0), 0, plateZ)}" rpy="0 0 0"/>
      <geometry><box size="${xyz(L, W, t)}"/></geometry>
    </collision>
${inertial(b.bodyKg, [X(b.com[0]), b.com[1], b.com[2]], bodyInertia(spec, b.com) ?? boxInertia(b.bodyKg, L, W, 0.03))}
  </link>
${wheel("left", 1)}
${wheel("right", -1)}
${b.skid ? `${wheel("left_rear", 1, b.casterX)}
${wheel("right_rear", -1, b.casterX)}` : `  <link name="caster_link">
    <visual><geometry><sphere radius="${f(b.casterR)}"/></geometry></visual>
    <collision><geometry><sphere radius="${f(b.casterR)}"/></geometry></collision>
${inertial(b.casterKg, [0, 0, 0], sphereInertia(b.casterKg, b.casterR))}
  </link>
  <joint name="caster_joint" type="fixed">
    <parent link="base_link"/>
    <child link="caster_link"/>
    <origin xyz="${xyz(X(b.casterX), 0, b.casterR)}" rpy="0 0 0"/>
  </joint>`}
  <link name="range_sensor_link">
    <visual><geometry><box size="${xyz(mm(s.sizeMm[0]), mm(s.sizeMm[1]), mm(s.sizeMm[2]))}"/></geometry></visual>
  </link>
  <joint name="range_sensor_joint" type="fixed">
    <parent link="base_link"/>
    <child link="range_sensor_link"/>
    <origin xyz="${xyz(X(mm(s.xMm)), mm(s.yMm), mm(s.zMm))}" rpy="0 0 0"/>
  </joint>${imuLink}
${boards}
  <ros2_control name="${name}_system" type="system">
    <hardware>
      <plugin>${HARDWARE_PLUGIN[hw]}</plugin>${
				hw === "mock"
					? `
      <param name="calculate_dynamics">true</param>`
					: ""
			}${
				hw === "bringup"
					? `
      <param name="port">${opts.port ?? "tcp:127.0.0.1:5555"}</param>
      <param name="max_wheel_rad_s">${f(maxWheelRadS(spec))}</param>${cpr ? `
      <param name="rad_per_count">${g((2 * Math.PI) / cpr)}</param>` : ""}`
					: ""
			}
    </hardware>
${joints}
    <sensor name="range_sensor">
      <state_interface name="range"/>
    </sensor>${imuSensor}
  </ros2_control>
</robot>
`
}

// The diff_drive_controller's settings from the same design: wheel separation and radius from the drive, speed and
// acceleration limits from the brief and the motor. With encoders (the motor's encoderCountsPerRev) the odometry is the
// wheels' measured turns; without, open loop: it integrates the commands (the ros-odometry check blocks navigation on
// it). With an IMU, its broadcaster publishes the gyro's heading on /imu_sensor_broadcaster/imu.
// The drive's limits, shared by the diff-drive controller and Nav2 (nav2.ts): the wheel's radius, the motor's loaded top
// speed, the brief's speed within it, and the acceleration ROS ramps at. ROS's commands ramp no faster than the robot can
// follow: a step from +0.9 to -0.9 m/s overshot the wheels through the motor's delay (QEMU rover, 23 Nov 2026).
export function driveLimits(spec: ChassisSpec) {
	const d = spec.drive
	const r = mm(d.wheelDiameterMm) / 2
	const topMps = ((spec.motor.noLoadRpm * spec.pack.nominalV) / spec.motor.ratedV) * 0.8 * ((2 * Math.PI) / 60) * r
	const vmax = Math.min(topMps, Math.max(spec.speedMps, 0.05))
	const accel = d.maxAccelMps2 ?? drivenDecel(onWheelsShare(d, spec.com[0])) / 2
	return { r, topMps, vmax, accel, wMax: (2 * vmax) / mm(d.trackMm), alphaMax: (2 * accel) / mm(d.trackMm) }
}

export function controllersYaml(spec: ChassisSpec, opts: { updateRateHz?: number; encoders?: boolean } = {}): string {
	const encoders = opts.encoders ?? !!spec.motor.encoderCountsPerRev
	const d = spec.drive
	const { r, topMps, vmax, accel } = driveLimits(spec)
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
      type: range_sensor_broadcaster/RangeSensorBroadcaster${spec.imu ? `
    imu_sensor_broadcaster:
      type: imu_sensor_broadcaster/IMUSensorBroadcaster` : ""}

diff_drive_controller:
  ros__parameters:
    left_wheel_names: [${d.kind === "skid4" ? '"left_wheel_joint", "left_rear_wheel_joint"' : '"left_wheel_joint"'}]  # skid steer: both wheels of a side
    right_wheel_names: [${d.kind === "skid4" ? '"right_wheel_joint", "right_rear_wheel_joint"' : '"right_wheel_joint"'}]
    wheel_separation: ${f(mm(d.trackMm))}  # drive.trackMm
    wheel_radius: ${f(r)}  # the wheel's catalog diameter / 2
    open_loop: ${encoders ? "false" : "true"}  # ${encoders ? "encoders on both wheels: odometry is the measured wheel turns" : "no wheel encoders: odometry is the integrated command"}
    base_frame_id: base_footprint
    odom_frame_id: odom
    publish_rate: ${rate}.0
    enable_odom_tf: true
    cmd_vel_timeout: 0.5
    linear.x.max_velocity: ${f(vmax)}  # the brief's speed, within the motor's loaded top speed (${f(topMps)} m/s)
    linear.x.min_velocity: ${f(-vmax)}
    angular.z.max_velocity: ${f((2 * vmax) / mm(d.trackMm))}  # wheels at full speed in opposite directions
    angular.z.min_velocity: ${f((-2 * vmax) / mm(d.trackMm))}
    linear.x.max_acceleration: ${f(accel)}  # ${d.maxAccelMps2 ? "the design's drive.maxAccelMps2" : "half the floor's grip on the driven wheels (the mechanics checks' traction limit): an ESTIMATE"}; braking the same
    angular.z.max_acceleration: ${f((2 * accel) / mm(d.trackMm))}  # the wheels at that acceleration in opposite directions

range_sensor_broadcaster:
  ros__parameters:
    sensor_name: range_sensor
    frame_id: range_sensor_link
    radiation_type: 1  # infrared (the time-of-flight sensor's laser)
    field_of_view: ${f(((spec.sensor as { fovDeg?: number }).fovDeg ?? 25) * Math.PI / 180)}
    min_range: 0.03
    max_range: ${f(mm(spec.sensor.rangeMm))}  # the sensor's datasheet range
${spec.imu ? `
imu_sensor_broadcaster:
  ros__parameters:
    sensor_name: imu
    frame_id: imu_link
    # Variances: heading from the gyro's drift (${spec.imu.biasDegPerS} deg/s bias, an ESTIMATE), yaw rate from its noise
    # (${spec.imu.noiseDegPerSqrtS} deg/sqrt(s)). Roll and pitch aren't measured: a huge variance, so a filter ignores them
    # (-1 in element 0 would mark the whole field unknown, heading included). Accelerations: none, -1 (sensor_msgs/Imu).
    static_covariance_orientation: [1.0e6, 0.0, 0.0, 0.0, 1.0e6, 0.0, 0.0, 0.0, ${g(((spec.imu.biasDegPerS * Math.PI) / 180) ** 2)}]
    static_covariance_angular_velocity: [1.0e6, 0.0, 0.0, 0.0, 1.0e6, 0.0, 0.0, 0.0, ${g(((spec.imu.noiseDegPerSqrtS * Math.PI) / 180) ** 2)}]
    static_covariance_linear_acceleration: [-1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
` : ""}`
}

// The arm's ROS 2 description (arm task 4), in the arm's frame (src/arm/kinematics.ts: base_link at the base plate's top
// centre, x forward, y left, z up) and with the MuJoCo model's numbers (py/mech/arm_model.py): a revolute joint per
// contract joint (underscored: base_yaw, shoulder, elbow, wrist_pitch, wrist_roll), the pitch joints about -y so a
// positive angle raises the link as in the contract; two prismatic fingers, the right mimicking the left. Each joint's
// effort is ARM_TORQUE_SHARE of its servo's stall torque at the rail (what the torque check allows), its velocity the
// servo's no-load speed. Masses: the printed links' measured ones (arm.links) or the armLinkG / armGripperG ESTIMATES,
// each servo's catalog mass at its joint, every link a point mass at its centre of mass (said in the file).
export const ARM_ROS_JOINTS: Record<ArmJointName, string> = { "base-yaw": "base_yaw", shoulder: "shoulder", elbow: "elbow", "wrist-pitch": "wrist_pitch", "wrist-roll": "wrist_roll" }
export const ARM_FINGER_JOINT = "gripper_left_finger_joint"
const ARM_POINT_I = 1e-6 // kg·m²: a small inertia on each point mass so a physics engine accepts it

export function armJointLimits(arm: ArmSpec, cat: MechCatalog) {
	const share = est("ARM_TORQUE_SHARE")
	return ARM_JOINTS.map((n) => {
		const j = arm.joints.find((x) => x.name === n)!
		const sv = byMpn(cat.servos ?? [], j.servo)
		const at = sv ? servoAt(sv, arm.railV) : { error: `${j.servo} not in the catalog` }
		if ("error" in at) throw new Error(`arm joint ${n}: ${at.error}`)
		return { name: n, ros: ARM_ROS_JOINTS[n], lower: (j.minDeg * Math.PI) / 180, upper: (j.maxDeg * Math.PI) / 180, effort: share * at.stallNm, velocity: (at.degPerS * Math.PI) / 180, servoKg: sv!.massG / 1000, linkMm: j.linkMm }
	})
}

export function armUrdf(arm: ArmSpec, cat: MechCatalog, opts: { name?: string; hardware?: RosHardware; port?: string } = {}): string {
	const name = opts.name ?? "bringup_arm"
	const hw = opts.hardware ?? "mock"
	const lim = armJointLimits(arm, cat)
	const by = Object.fromEntries(lim.map((l) => [l.name, l])) as Record<ArmJointName, (typeof lim)[number]>
	const measured = new Map((arm.links ?? []).map((l) => [l.name, l]))
	const gripSv = byMpn(cat.servos ?? [], arm.gripper.servo)
	const pointI = { ixx: ARM_POINT_I, iyy: ARM_POINT_I, izz: ARM_POINT_I }
	// A link's mass and centre: measured, else the estimate along the link; plus the servo it carries at its far end.
	const linkInertial = (n: ArmJointName | "gripper", lengthMm: number, carriedKg: number) => {
		const m = measured.get(n)
		const printed = m ? m.massG / 1000 : n === "gripper" ? est("armGripperG") / 1000 : (est("armLinkG") * lengthMm) / 100 / 1000
		const at: [number, number, number] = m ? [mm(m.comMm[0]), mm(m.comMm[1]), mm(m.comMm[2])] : [mm(lengthMm) / 2, 0, 0]
		const total = printed + carriedKg
		// The carried servo sits at the link's far end (the next joint).
		const com: [number, number, number] = total > 0 ? [(at[0] * printed + mm(lengthMm) * carriedKg) / total, (at[1] * printed) / total, (at[2] * printed) / total] : [0, 0, 0]
		return inertial(Math.max(total, 1e-4), com, pointI)
	}
	const capsule = (lengthMm: number) => `    <visual>
      <origin xyz="${xyz(mm(lengthMm) / 2, 0, 0)}" rpy="0 1.570796 0"/>
      <geometry><cylinder radius="0.008" length="${f(Math.max(mm(lengthMm), 0.001))}"/></geometry>
    </visual>`
	const L = (n: ArmJointName) => by[n].linkMm
	const L3roll = L("wrist-roll")
	const open = mm(arm.gripper.openMm) / 2
	const finger = mm(arm.gripper.fingerMm)
	const chain: { joint: ArmJointName; parent: string; child: string; origin: [number, number, number]; axis: string; inertialXml: string; visual: string }[] = [
		{ joint: "base-yaw", parent: "base_link", child: "turntable_link", origin: [0, 0, 0], axis: "0 0 1", inertialXml: linkInertial("base-yaw", 0, by.shoulder.servoKg), visual: "" },
		{ joint: "shoulder", parent: "turntable_link", child: "upper_arm_link", origin: [mm(L("base-yaw")), 0, mm(arm.base.shoulderZMm)], axis: "0 -1 0", inertialXml: linkInertial("shoulder", L("shoulder"), by.elbow.servoKg), visual: capsule(L("shoulder")) },
		{ joint: "elbow", parent: "upper_arm_link", child: "forearm_link", origin: [mm(L("shoulder")), 0, 0], axis: "0 -1 0", inertialXml: linkInertial("elbow", L("elbow"), by["wrist-pitch"].servoKg), visual: capsule(L("elbow")) },
		{ joint: "wrist-pitch", parent: "forearm_link", child: "wrist_link", origin: [mm(L("elbow")), 0, 0], axis: "0 -1 0", inertialXml: linkInertial("wrist-pitch", L("wrist-pitch"), by["wrist-roll"].servoKg), visual: capsule(L("wrist-pitch")) },
		{ joint: "wrist-roll", parent: "wrist_link", child: "gripper_link", origin: [mm(L("wrist-pitch")), 0, 0], axis: "1 0 0", inertialXml: linkInertial("gripper", L3roll, (gripSv?.massG ?? 0) / 1000), visual: capsule(L3roll - arm.gripper.fingerMm / 2) },
	]
	const links = chain
		.map((c) => `  <link name="${c.child}">
${c.visual ? c.visual + "\n" : ""}${c.inertialXml}
  </link>
  <joint name="${by[c.joint].ros}" type="revolute">
    <parent link="${c.parent}"/>
    <child link="${c.child}"/>
    <origin xyz="${xyz(...c.origin)}" rpy="0 0 0"/>
    <axis xyz="${c.axis}"/>
    <limit lower="${f(by[c.joint].lower)}" upper="${f(by[c.joint].upper)}" effort="${f(by[c.joint].effort)}" velocity="${f(by[c.joint].velocity)}"/>
  </joint>`)
		.join("\n")
	const gripAt = mm(L3roll)
	const fingerLink = (side: "left" | "right", sign: 1 | -1) => `  <link name="gripper_${side}_finger_link">
    <visual>
      <origin xyz="0 ${f((sign * 0.004) / 2)} 0" rpy="0 0 0"/>
      <geometry><box size="${xyz(finger, 0.004, 0.016)}"/></geometry>
    </visual>
    <collision>
      <origin xyz="0 ${f((sign * 0.004) / 2)} 0" rpy="0 0 0"/>
      <geometry><box size="${xyz(finger, 0.004, 0.016)}"/></geometry>
    </collision>
${inertial(0.004, [0, 0, 0], boxInertia(0.004, finger, 0.004, 0.016))}
  </link>
  <joint name="gripper_${side}_finger_joint" type="prismatic">
    <parent link="gripper_link"/>
    <child link="gripper_${side}_finger_link"/>
    <origin xyz="${xyz(gripAt, 0, 0)}" rpy="0 0 0"/>
    <axis xyz="0 ${sign} 0"/>
    <limit lower="0" upper="${f(open)}" effort="${f(gripSv ? ((x) => ("error" in x ? 0 : x.stallNm / 0.01))(servoAt(gripSv, arm.railV)) : 0)}" velocity="0.1"/>${side === "right" ? `
    <mimic joint="${ARM_FINGER_JOINT}" multiplier="1" offset="0"/>` : ""}
  </joint>`
	const iface = (joint: string) => `    <joint name="${joint}">
      <command_interface name="position"/>
      <state_interface name="position"/>
      <state_interface name="velocity"/>
    </joint>`
	return `<?xml version="1.0"?>
<!-- Generated by Bringup from the design contract (src/ros/urdf.ts armUrdf). Do not edit: change the design instead.
     Link masses: ${arm.links?.length ? "the printed links' measured masses (arm.links)" : "ESTIMATES (armLinkG per 100 mm, armGripperG) until the arm's parts are built"}, plus each servo's catalog mass; each link a point mass.
     Joint effort: ${est("ARM_TORQUE_SHARE")} x the servo's stall torque at ${arm.railV} V; velocity: its no-load speed. Finger effort: the gripper servo's stall on a 10 mm horn (ESTIMATE). -->
<robot name="${name}">
  <link name="base_link">
    <visual>
      <origin xyz="${xyz(0, 0, -mm(arm.base.thicknessMm) / 2)}" rpy="0 0 0"/>
      <geometry><box size="${xyz(mm(arm.base.plateMm[0]), mm(arm.base.plateMm[1]), mm(arm.base.thicknessMm))}"/></geometry>
    </visual>
  </link>
${links}
  <link name="grip_link"/>
  <joint name="grip_joint" type="fixed">
    <parent link="gripper_link"/>
    <child link="grip_link"/>
    <origin xyz="${xyz(gripAt, 0, 0)}" rpy="0 0 0"/>
  </joint>
${fingerLink("left", 1)}
${fingerLink("right", -1)}
  <ros2_control name="${name}_system" type="system">
    <hardware>
      <plugin>${HARDWARE_PLUGIN[hw]}</plugin>${hw === "bringup" ? `
      <param name="port">${opts.port ?? "tcp:127.0.0.1:5555"}</param>` : ""}
    </hardware>
${lim.map((l) => iface(l.ros)).join("\n")}
${iface(ARM_FINGER_JOINT)}
  </ros2_control>
</robot>
`
}

// The arm's controllers: a joint_trajectory_controller over the five joints (the firmware's moves) and a parallel
// gripper action on the left finger (the right mimics it).
export function armControllersYaml(arm: ArmSpec, cat: MechCatalog, opts: { updateRateHz?: number } = {}): string {
	const lim = armJointLimits(arm, cat)
	const rate = opts.updateRateHz ?? 50
	return `# Generated by Bringup from the design contract (src/ros/urdf.ts). Do not edit: change the design instead.
controller_manager:
  ros__parameters:
    update_rate: ${rate}  # a hobby servo's 50 Hz pulse
    joint_state_broadcaster:
      type: joint_state_broadcaster/JointStateBroadcaster
    arm_controller:
      type: joint_trajectory_controller/JointTrajectoryController
    gripper_controller:
      type: parallel_gripper_action_controller/GripperActionController

arm_controller:
  ros__parameters:
    joints: [${lim.map((l) => `"${l.ros}"`).join(", ")}]
    command_interfaces: [position]
    state_interfaces: [position, velocity]
    allow_partial_joints_goal: false
    constraints:
      goal_time: 0.5
${lim.map((l) => `      ${l.ros}: { goal: 0.05 }  # rad; ${l.name}: ${f(l.lower)}…${f(l.upper)} rad, ${f(l.velocity)} rad/s`).join("\n")}

gripper_controller:
  ros__parameters:
    joint: ${ARM_FINGER_JOINT}
    max_velocity: 0.1
    allow_stalling: true  # closing on the object stalls the fingers: that is the grasp
`
}
