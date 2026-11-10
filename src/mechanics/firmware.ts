import type { ContractSnapshot } from "../contract/types.ts"
import { byMpn } from "./catalog.ts"
import { defaultCheckCatalog } from "./checks.ts"
import { est } from "./estimates.ts"
import { G, motorAt } from "./model.ts"
import { sensorDriver } from "../codegen/firmware.ts"

// The rover firmware's header (templates/fw-rover/include/hw_pins.h), from the contract: the driver's and the bus's
// pins, and the control numbers the mechanics fix. Stop distance: the brief's distance from the wall plus 1.5× (the
// braking distance on the floor and one sensor period of travel at cruise). Cruise duty: the target speed over the
// loaded top speed at the cell's nominal voltage. Turn: a quarter turn in place at cruise.
export const STOP_MARGIN = 1.5
export const SLOW_ZONE_MM = 300

export function roverHeader(s: ContractSnapshot): string {
	const v = s.values
	const mech = v.mechanics!, motion = v.motion!
	const cat = defaultCheckCatalog()!
	const motor = byMpn(cat.mech.motors, mech.drive.motor)!, wheel = byMpn(cat.mech.wheels, mech.drive.wheel)!, pack = byMpn(cat.mech.batteries, mech.battery.pack)!
	const sensor = byMpn(cat.mech.sensors, mech.sensor.module)!
	const pin = (sig: string) => (v.pins ?? []).find((p) => p.signal === sig)?.gpio ?? -1
	const r = wheel.diameterMm / 2000
	const topMps = motorAt(motor, pack.nominalV).noLoadRadS * 0.8 * r
	const speed = motion.speedMps
	const brakeMm = (speed ** 2 / (2 * est("floorMu") * G)) * 1000
	const stop = Math.ceil(motion.stopBeforeWallMm + STOP_MARGIN * (brakeMm + speed * sensor.updateMs))
	const cruise = Math.min(1, Math.max(0.3, speed / topMps))
	const turnMs = Math.round((Math.PI / 2 / ((2 * speed) / (mech.drive.trackMm / 1000))) * 1000)
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
		// What else the rover firmware drives and reads, named as the product firmware names them so the same checks
		// apply: the status LED (a 1 Hz heartbeat) and the payload sensor, only the one hw_board.cpp can read (SHT40).
		...(v.pins ?? []).filter((p) => p.signal === "STATUS_LED").map((p) => `#define PIN_STATUS_LED ${p.gpio}`),
		...(sensorDriver((v.parts ?? []).find((p) => p.role === "sensor")?.mpn ?? "") === "SHT40" ? ["#define SENSOR_SHT40 1"] : []),
		"",
	]
	return lines.join("\n")
}
