// Every robot carries an IMU (the user, 17 Nov 2026, asked which robots should: "Every robot"): its turns and its
// straight close on the gyro's heading, the wheel encoders still give the distance. The catalog's IMU (role imu, the
// LSM6DS3TR-C) is added in code to a robot's parts that have none, under a free U ref; the board generator wires it
// (circuit.ts: the I2C bus, 3V3 with its 100 nF, the straps). Pure: the contract tools apply it on a robot's parts,
// motion and mechanics writes, with the power tree and the MCU move, in one parts write.
import type { Part } from "./types.ts"

type CatalogPart = Part & { lcsc: string | null }

export function withRobotImu(parts: Part[], catalog: CatalogPart[]): { parts: Part[]; note: string | null } {
	if (parts.some((p) => p.role === "imu") || !parts.some((p) => p.role === "mcu")) return { parts, note: null }
	const entry = catalog.find((c) => c.role === "imu")
	if (!entry) return { parts, note: null }
	const taken = new Set(parts.map((p) => p.ref))
	let n = 2
	while (taken.has(`U${n}`)) n++
	const { ref: _r, ...rest } = entry as CatalogPart & Record<string, unknown>
	const imu = { ...(rest as unknown as Part), ref: `U${n}`, reason: "every robot carries an IMU (the user, 17 Nov 2026: \"Every robot\"): the turns close on the gyro's heading" }
	return { parts: [...parts, imu], note: `added U${n} ${entry.mpn} (the IMU every robot carries: its turns close on the gyro's heading)` }
}
