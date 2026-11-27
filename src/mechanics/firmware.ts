import type { ContractSnapshot } from "../contract/types.ts"
import { byMpn } from "./catalog.ts"
import { defaultCheckCatalog } from "./checks.ts"
import { TURN_CLEARANCE_MM, brakeMm, drivenDecel, cruiseDuty, loadedSpeedMps, massAndCom, mounts, onWheelsShare, payloadMount, turnStopMm, drivenWheels, isSkid, SKID_TURN_SIM_SHARE, skidEffectiveTrackMm, skidTurnWheelMps } from "./model.ts"
import { checkBoards, withAssembly } from "./assembly.ts"
import { macroName, sensorDriver } from "../codegen/firmware.ts"

// The rover firmware's header (templates/fw-rover/include/hw_pins.h), from the contract: the driver's and the bus's
// pins, and the control numbers the mechanics fix. Stop distance: the brief's distance from the wall plus 1.5× (the
// braking distance on the floor and one sensor period of travel at cruise), and at least what the turn in place there
// needs to sweep clear. Cruise duty: the target speed on the motor's
// load line from a full pack (model.ts cruiseDuty). Turn: a quarter turn in place at cruise.
export const STOP_MARGIN = 1.5
export const SLOW_ZONE_MM = 300
// With wheel encoders: duty per count of difference between the wheels on a straight (rover.cpp). An ESTIMATE, set in
// the simulation: about a 0.1 duty correction for 100 counts (2 cm of wheel travel on the 80 mm wheels).
export const HOLD_GAIN = 0.001

// The counts a wheel turns for the rover to turn by `rad` in place: each wheel runs an arc of rad × track / 2.
export const turnCounts = (rad: number, trackMm: number, wheelMm: number, countsPerRev: number) => Math.round(((rad * trackMm) / 2 / (Math.PI * wheelMm)) * countsPerRev)
// Counts per wheel revolution of an encoder gearmotor, or null. With channel A only (the ESP32-C3: one GPIO per wheel,
// 16 Nov) the firmware counts both edges of A, half the catalog's cpr (which counts both channels), its direction from
// the duty it drives; with both channels (quadrature, the ESP32-S3's PCNT or rover_quad.h) every edge of A and B: the
// catalog's cpr.
export const countsPerRev = (motor: { gearRatio: number; encoder?: { cpr: number } }, quadrature = false) => (motor.encoder ? (quadrature ? motor.encoder.cpr : motor.encoder.cpr / 2) * motor.gearRatio : null)
// Both channels of both drive wheels' encoders on GPIOs: the firmware counts in quadrature.
export const quadratureWired = (pins: { signal: string; gpio: number }[] | undefined) => ["ENC_LA", "ENC_LB", "ENC_RA", "ENC_RB"].every((sig) => (pins ?? []).some((p) => p.signal === sig && typeof p.gpio === "number" && p.gpio >= 0))

// The signals the rover firmware drives that the contract hasn't put on a GPIO yet (roverHeader would write -1).
export const ROVER_SIGNALS = ["MOT_AIN1", "MOT_AIN2", "MOT_BIN1", "MOT_BIN2", "I2C_SDA", "I2C_SCL"]
export function unassignedRoverPins(s: ContractSnapshot): string[] {
	const motor = s.values.mechanics ? byMpn(defaultCheckCatalog()?.mech.motors ?? [], s.values.mechanics.drive.motor) : undefined
	return [...ROVER_SIGNALS, ...(s.values.mechanics?.safety?.start ? ["START"] : []), ...(motor?.encoder ? ["ENC_LA", "ENC_RA"] : [])].filter((sig) => !(s.values.pins ?? []).some((p) => p.signal === sig && typeof p.gpio === "number" && p.gpio >= 0))
}

// The opponent hold (rover_hold.h, under motion.rules): the gap kept to the robot ahead, how much farther it must be to
// count as gone, the VL53L0X's blind range (no reading under about 30 mm; a hold near it keeps holding), and the
// longest hold before what is ahead counts as fixed (a wall) and the drive turns away as usual: design choices.
export const OPPONENT_GAP_MM = 150
export const HOLD_CLEAR_MM = 50
export const SENSOR_BLIND_MM = 60
export const HOLD_MAX_MS = 5000
// Go-to-point (rover_odo.h, with encoders): the least duty it drives at near the target, as a share of cruise: an
// estimate that keeps the wheels turning against the gearbox's friction, checked in the simulated drive.
export const GOTO_MIN_SHARE = 0.4

export function roverHeader(s: ContractSnapshot): string {
	const v = s.values
	const mech = v.mechanics!, motion = v.motion!
	const cat = defaultCheckCatalog()!
	const motor = byMpn(cat.mech.motors, mech.drive.motor), wheel = byMpn(cat.mech.wheels, mech.drive.wheel), pack = byMpn(cat.mech.batteries, mech.battery.pack)
	const sensor = byMpn(cat.mech.sensors, mech.sensor.module)
	// A part the catalog doesn't have: the mech-fit check names it to the mechanics engineer; the firmware says so too.
	if (!motor || !wheel || !pack || !sensor) {
		const missing = [!motor && `motor ${mech.drive.motor}`, !wheel && `wheel ${mech.drive.wheel}`, !pack && `battery ${mech.battery.pack}`, !sensor && `sensor ${mech.sensor.module}`].filter(Boolean)
		throw new Error(`rover firmware not built: ${missing.join(", ")} not in catalog/mechanics.json (the mechanics design must name catalog parts)`)
	}
	const pin = (sig: string) => (v.pins ?? []).find((p) => p.signal === sig)?.gpio ?? -1
	const r = wheel.diameterMm / 2000
	const speed = motion.speedMps
	// Cruise duty on the motor's load line (model.ts cruiseDuty, the same model as the "Top speed" and "Cruise duty"
	// checks): set for a full pack, where the rover is fastest and the simulated drive starts. No floor: a motor geared so
	// fast that the duty falls under MIN_CRUISE_DUTY is the "Cruise duty" check's finding, not a silent speed-up.
	const boards = checkBoards(s).map((b) => ({ name: b.name, outline: { widthMm: b.snapshot.values.outline?.widthMm ?? 0, heightMm: b.snapshot.values.outline?.heightMm ?? 0 } }))
	const geom = withAssembly(v) ?? mech
	const { massG, com } = massAndCom([...mounts(geom, boards, cat.mech), payloadMount(geom, motion.payloadG)])
	// Braking on the drive wheels' share of the weight only (model.ts brakeMm, as the Stopping distance check).
	// And far enough that the turn in place there sweeps clear of the wall (model.ts turnStopMm): a 246 mm rover-pi with
	// its axle forward swept its rear corner into the wall it had just turned from (premerge review, 15 Nov).
	const brakeStop = motion.stopBeforeWallMm + STOP_MARGIN * (brakeMm(speed, onWheelsShare(geom.drive, com[0]), mech.drive.maxAccelMps2) + speed * sensor.updateMs)
	const stop = Math.ceil(Math.max(brakeStop, turnStopMm(geom, wheel)))
	const cruise = Math.min(1, Math.max(0, cruiseDuty(motor, pack, speed, massG / 1000, r, drivenWheels(mech.drive))))
	// Three eighths of a turn, not a quarter: an open-loop quarter turn leaves the rover running along the wall it just
	// faced, at whatever small angle the turn missed by, which its forward-only sensor can't see (real rover run on the
	// Claude subscription, 15 Nov: stopped 173 mm short, turned, drove 0.73 m and clipped that wall). Turning further
	// heads it away.
	// A skid-steer rover turns slower than it rolls: its wheels scrub sideways (model.ts skidTurnWheelMps).
	const turnSpeed = isSkid(mech.drive) ? skidTurnWheelMps(motor, pack, cruise, massG / 1000, mech.drive, r) : speed
	// The timed turn (no encoders) of a skid-steer rover runs on the effective track and the measured share below.
	const turnTrackMm = isSkid(mech.drive) ? skidEffectiveTrackMm(mech.drive) : mech.drive.trackMm
	// The encoder-closed turn and the odometry count the wheels' own travel, which includes their forward slip: the
	// derived effective track B·(1+(L/B)²) (1.5 B here). The simulation slips more: 719 counts turned 92° of a planned
	// 135° (2.2 B, rover-4wd, 16 Nov 2026), and on the plain track B the turn fell to 67° and hit the front wall. Across
	// 1.5–2.2 B the turn lands between 135° and about 90°, and the drive passed at 92° with 145 mm from every wall; real
	// tyres measure 1.2–2 B in the literature. A bench calibration of the ratio is open (docs/backlog.md).
	const countTrackMm = turnTrackMm
	const turnMs = Math.round(((3 * Math.PI) / 4 / ((2 * turnSpeed * (isSkid(mech.drive) ? SKID_TURN_SIM_SHARE : 1)) / (turnTrackMm / 1000))) * 1000)
	const lines = [
		"// Generated from the design contract (src/mechanics/firmware.ts). Do not edit.",
		"#pragma once",
		...["MOT_AIN1", "MOT_AIN2", "MOT_BIN1", "MOT_BIN2", "I2C_SDA", "I2C_SCL"].map((sig) => `#define ${sig} ${pin(sig)}`),
		`#define ROVER_PERIOD_MS ${sensor.updateMs}`,
		`#define ROVER_RANGE_MM ${sensor.rangeMm}`,
		`#define ROVER_STOP_MM ${stop}`,
		`#define ROVER_SLOW_MM ${stop + SLOW_ZONE_MM}`,
		`#define ROVER_CRUISE_DUTY ${cruise.toFixed(3)}f`,
		`#define ROVER_TURN_MS ${turnMs}`,
		// Wheel encoders on GPIOs: the turn and the straight close on their counts (rover.h); the same three eighths of a turn.
		...((cpr) => (cpr && ["ENC_LA", "ENC_RA"].every((sig) => pin(sig) >= 0) ? [...(quadratureWired(v.pins) ? ["#define ROVER_ENC_QUADRATURE 1"] : []), `#define ROVER_ENC_COUNTS_PER_REV ${cpr.toFixed(1)}f`, `#define ROVER_TURN_COUNTS ${turnCounts((3 * Math.PI) / 4, countTrackMm, wheel.diameterMm, cpr)}`, `#define ROVER_HOLD_GAIN ${HOLD_GAIN}f`, `#define ROVER_MM_PER_COUNT ${((Math.PI * wheel.diameterMm) / cpr).toFixed(4)}f`, `#define ROVER_TRACK_MM ${countTrackMm.toFixed(1)}f`, ...(mech.drive.turnScale !== undefined ? [`#define ROVER_TURN_SCALE ${mech.drive.turnScale.toFixed(5)}f`] : []), ...(mech.drive.coastMm !== undefined ? [`#define ROVER_COAST_MM ${mech.drive.coastMm.toFixed(1)}f`] : []), ...(mech.drive.wheelScale !== undefined ? [`#define ROVER_WHEEL_SCALE ${mech.drive.wheelScale.toFixed(5)}f`] : []), `#define ROVER_GOTO_MIN_DUTY ${(GOTO_MIN_SHARE * cruise).toFixed(3)}f`, `#define ROVER_GOTO_GAP_MM ${OPPONENT_GAP_MM}`, `#define ROVER_BACK_COUNTS ${Math.round((TURN_CLEARANCE_MM / (Math.PI * wheel.diameterMm)) * cpr)}`] : []))(countsPerRev(motor, quadratureWired(v.pins))),
		// The robot's IMU (role imu, the LSM6DS3TR-C; the user, 17 Nov 2026: "Every robot"): the turn closes on the gyro's
		// heading, the same three eighths of a turn the counts aim for (rover_enc.h; hw_board.cpp reads it).
		...((v.parts ?? []).some((p) => p.role === "imu") ? ["#define IMU_LSM6DS3 1", `#define ROVER_TURN_RAD ${((3 * Math.PI) / 4).toFixed(4)}f`] : []),
		// Without encoders, the back-off before a turn in place is timed: the same TURN_CLEARANCE_MM at cruise speed (the
		// narrow rover turned in place 188 mm from the side wall, straddling the course's step, walked ~170 mm and touched
		// it, 22 Nov 2026; an encoder rover backs off by counts and didn't).
		`#define ROVER_BACK_MS ${Math.round((TURN_CLEARANCE_MM / (speed * 1000)) * 1000)}`,
		// Before a turn in place the motors stop long enough to brake from cruise (rover_enc.h restMs), so the robot
		// pivots where turnStopMm placed it: wheels spun against each other don't brake the body, and the narrow rover
		// slid 94 mm toward the side wall during its turn (22 Nov 2026).
		`#define ROVER_REST_MS ${Math.ceil(STOP_MARGIN * (speed / drivenDecel(onWheelsShare(geom.drive, com[0]), mech.drive.maxAccelMps2)) * 1000 + sensor.updateMs)}`,
		// An acceleration limit (mechanics.drive.maxAccelMps2): the duty moves at most this much per control tick, so the speed
		// (the load line's at full duty from a full pack, at most) changes no faster: main.cpp ramps every output.
		...(mech.drive.maxAccelMps2 ? [`#define ROVER_RAMP_PER_TICK ${(mech.drive.maxAccelMps2 * (sensor.updateMs / 1000) / Math.max(0.01, loadedSpeedMps(motor, pack, pack.fullV, 1, massG / 1000, r))).toFixed(4)}f`] : []),
		// Under a competition's rules (motion.rules): stop for the opponent ahead and wait for it to leave (rover_hold.h).
		// OPPONENT_GAP_MM short of it plus the braking and one sensor period, and never inside the wall stop distance, so
		// the hold always comes before the drive's turn away. Eurobot's F.6 (p. 14) asks for an avoidance system that
		// prevents collisions and names no distance: the 150 mm is the run 15 review's margin, a design choice.
		...(motion.rules ? ((hold) => [`#define ROVER_HOLD_MM ${hold}`, `#define ROVER_CLEAR_MM ${hold + HOLD_CLEAR_MM}`, `#define ROVER_BLIND_MM ${SENSOR_BLIND_MM}`, `#define ROVER_HOLD_MAX_MS ${HOLD_MAX_MS}UL`])(Math.ceil(Math.max(stop, brakeStop - motion.stopBeforeWallMm + OPPONENT_GAP_MM))) : []),
		// A pull-cord start (main.cpp, match.h): the match length, when the mechanics give one; PIN_START comes below.
		...(mech.safety?.start?.matchS ? [`#define MATCH_MS ${Math.round(mech.safety.start.matchS * 1000)}UL`] : []),
		// What else the rover firmware drives and reads, named as the product firmware names them so the same checks
		// apply: the status LED (a 1 Hz heartbeat) and the payload sensor hw_board.cpp reads (SHT40 or SHTC3).
		...(v.pins ?? []).filter((p) => p.signal === "STATUS_LED").map((p) => `#define PIN_STATUS_LED ${p.gpio}`),
		// Servos and a spare motor through a PCA9685 on the I2C bus (circuit.ts servoOutputs; pca9685.h): its address
		// (A0-A5 low), the servo count on channels 0.., and the spare motor on channels 2 and 3.
		...((pwm) => (pwm ? [`#define PCA9685_ADDR 0x${(pwm.i2cAddress ?? 0x40).toString(16)}`, `#define SERVO_COUNT ${(v.parts ?? []).filter((p) => p.role === "servo").slice(0, 2).length}`, ...((v.parts ?? []).filter((p) => p.role === "motor-driver").length > 1 && v.mechanics?.drive.kind !== "skid4" ? ["#define SPARE_MOTOR_CH 2"] : [])] : []))((v.parts ?? []).find((p) => p.role === "pwm-driver") as { i2cAddress?: number } | undefined),
		// A link's pins (a UART's TX and RX), as the product firmware's pins.h names them: link.h opens the UART on them.
		...(v.pins ?? []).filter((p) => (v.links ?? []).some((l) => p.signal === `${l.id}_TX` || p.signal === `${l.id}_RX`)).map((p) => `#define ${macroName(p.signal)} ${p.gpio}`),
		// Every other contract pin, as the product firmware's pins.h names it (PIN_<SIGNAL>), so the firmware's pin table
		// covers the whole pin map: the rover code leaves them alone (native USB, a button), but the pin check no longer
		// sees "firmware drives BUTTON on ?", a finding no agent can fix (real rover run 8, 15 Nov: the run ended
		// unsettled on three of them with the drive passing and every build done).
		...(v.pins ?? [])
			.filter((p) => !["MOT_AIN1", "MOT_AIN2", "MOT_BIN1", "MOT_BIN2", "I2C_SDA", "I2C_SCL", "STATUS_LED"].includes(p.signal) && !(v.links ?? []).some((l) => p.signal === `${l.id}_TX` || p.signal === `${l.id}_RX`))
			.filter((p, i, all) => all.findIndex((q) => q.signal === p.signal) === i)
			.map((p) => `#define ${macroName(p.signal)} ${p.gpio}`),
		// The payload sensor hw_board.cpp reads, as the product firmware's pins.h names it (SHT40 or SHTC3; real rover run
		// 10, 15 Nov: the architect picked the SHTC3, which the rover firmware couldn't read).
		...((d) => (d ? [`#define SENSOR_${d} 1`] : []))(sensorDriver((v.parts ?? []).find((p) => p.role === "sensor")?.mpn ?? "")),
		"",
	]
	return lines.join("\n")
}
