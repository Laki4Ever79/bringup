import type { ContractSnapshot } from "../contract/types.ts"
import { byMpn } from "./catalog.ts"
import { defaultCheckCatalog } from "./checks.ts"
import { TURN_CLEARANCE_MM, brakeMm, cruiseDuty, massAndCom, mounts, onWheelsShare, payloadMount, turnStopMm } from "./model.ts"
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
// Counts per wheel revolution of an encoder gearmotor, or null. The firmware counts both edges of channel A only (half
// the catalog's cpr, which counts both channels), its direction from the duty it drives: one GPIO per wheel, as the
// ESP32-C3 has four free pins for the encoders, the start cord and the LED (16 Nov).
export const countsPerRev = (motor: { gearRatio: number; encoder?: { cpr: number } }) => (motor.encoder ? (motor.encoder.cpr / 2) * motor.gearRatio : null)

// The signals the rover firmware drives that the contract hasn't put on a GPIO yet (roverHeader would write -1).
export const ROVER_SIGNALS = ["MOT_AIN1", "MOT_AIN2", "MOT_BIN1", "MOT_BIN2", "I2C_SDA", "I2C_SCL"]
export function unassignedRoverPins(s: ContractSnapshot): string[] {
	const motor = s.values.mechanics ? byMpn(defaultCheckCatalog()?.mech.motors ?? [], s.values.mechanics.drive.motor) : undefined
	return [...ROVER_SIGNALS, ...(s.values.mechanics?.safety?.start ? ["START"] : []), ...(motor?.encoder ? ["ENC_LA", "ENC_RA"] : [])].filter((sig) => !(s.values.pins ?? []).some((p) => p.signal === sig && typeof p.gpio === "number" && p.gpio >= 0))
}

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
	const brakeStop = motion.stopBeforeWallMm + STOP_MARGIN * (brakeMm(speed, onWheelsShare(geom.drive, com[0])) + speed * sensor.updateMs)
	const stop = Math.ceil(Math.max(brakeStop, turnStopMm(geom, wheel)))
	const cruise = Math.min(1, Math.max(0, cruiseDuty(motor, pack, speed, massG / 1000, r)))
	// Three eighths of a turn, not a quarter: an open-loop quarter turn leaves the rover running along the wall it just
	// faced, at whatever small angle the turn missed by, which its forward-only sensor can't see (real rover run on the
	// Claude subscription, 15 Nov: stopped 173 mm short, turned, drove 0.73 m and clipped that wall). Turning further
	// heads it away.
	const turnMs = Math.round(((3 * Math.PI) / 4 / ((2 * speed) / (mech.drive.trackMm / 1000))) * 1000)
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
		...((cpr) => (cpr && ["ENC_LA", "ENC_RA"].every((sig) => pin(sig) >= 0) ? [`#define ROVER_ENC_COUNTS_PER_REV ${cpr.toFixed(1)}f`, `#define ROVER_TURN_COUNTS ${turnCounts((3 * Math.PI) / 4, mech.drive.trackMm, wheel.diameterMm, cpr)}`, `#define ROVER_HOLD_GAIN ${HOLD_GAIN}f`, `#define ROVER_BACK_COUNTS ${Math.round((TURN_CLEARANCE_MM / (Math.PI * wheel.diameterMm)) * cpr)}`] : []))(countsPerRev(motor)),
		// A pull-cord start (main.cpp, match.h): the match length, when the mechanics give one; PIN_START comes below.
		...(mech.safety?.start?.matchS ? [`#define MATCH_MS ${Math.round(mech.safety.start.matchS * 1000)}UL`] : []),
		// What else the rover firmware drives and reads, named as the product firmware names them so the same checks
		// apply: the status LED (a 1 Hz heartbeat) and the payload sensor hw_board.cpp reads (SHT40 or SHTC3).
		...(v.pins ?? []).filter((p) => p.signal === "STATUS_LED").map((p) => `#define PIN_STATUS_LED ${p.gpio}`),
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
