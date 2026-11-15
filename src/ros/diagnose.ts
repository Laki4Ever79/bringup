import type { AgentRole, ContractSnapshot, FieldName } from "../contract/types.ts"
import type { ChassisSpec } from "../tools/chassis.ts"
import { BOARD_PF, CABLE_PF_PER_M, DEVICE_PF, PULLUP_OHM } from "../dashboard/assembly-geom.js"
import { maxWheelRadS } from "./urdf.ts"

// From a ROS symptom to its cause in the design (docs/ros.md; the user, 15 Nov: "we have a unique possibility to solve
// bugs at PCB level here"). A robot's ROS run is measured against what its design promises: each topic's rate, the
// speed it reached. A shortfall is traced, by plain code over the contract, to the hardware that sets that number (the
// I2C bus and its pull-ups, the console link, the motors and the cell) and to the fields and owner that can fix it.
// Generic ROS tools see the graph; only the contract knows why a number should be what it is.

export interface TopicStats {
	count: number
	durationS: number
}
export interface RunMeasure {
	topics: Record<string, TopicStats>
	// What the robot did, where the truth is known (the simulation's own pose, or wheel encoders): m/s.
	achievedSpeedMps?: number
	commandedSpeedMps?: number
	// The run's console link to the ROS host: bits per second (115200 for the board's USB serial default).
	consoleBaud?: number
}
export interface Diagnosis {
	symptom: string
	cause: string
	fix: string
	fields: FieldName[]
	affects: AgentRole[]
	// How sure the rule is: "measured" when the design's own numbers say the cause is there, "suspect" when it only fits.
	confidence: "measured" | "suspect"
}

const hz = (t?: TopicStats) => (t && t.durationS > 0 ? t.count / t.durationS : undefined)

// The I2C bus the distance sensor reads over: the board's pins, the cable to the sensor (from the chassis: board to
// sensor mount, plus slack), the other devices on it. Rise time ~ 0.8473 x R x C (I2C spec); 1000 ns in standard mode.
export function i2cRise(spec: ChassisSpec, c: ContractSnapshot, pullupOhm = PULLUP_OHM): { cableMm: number; busPf: number; riseNs: number; devices: number } {
	const board = spec.boards[0]
	const dx = (spec.sensor.xMm - (board?.xMm ?? 0)) / 1000, dy = (spec.sensor.yMm - (board?.yMm ?? 0)) / 1000
	const cableMm = Math.round((Math.hypot(dx, dy) * 1000 + 50) / 10) * 10 // routed along the plate, 50 mm slack (estimate)
	const devices = (c.values.parts ?? []).filter((p) => p.role === "sensor").length + 1 // the payload sensor(s) and the distance sensor
	const busPf = BOARD_PF + devices * DEVICE_PF + (CABLE_PF_PER_M * cableMm) / 1000
	return { cableMm, busPf, riseNs: 0.8473 * pullupOhm * busPf * 1e-12 * 1e9, devices }
}

export function diagnose(spec: ChassisSpec, c: ContractSnapshot, m: RunMeasure): Diagnosis[] {
	const out: Diagnosis[] = []
	// 1. The range sensor's rate: the design promises one reading per sensor period.
	const rangeHz = hz(m.topics["/range_sensor_broadcaster/range"])
	const wantRange = 1000 / spec.sensor.updateMs
	if (rangeHz !== undefined && rangeHz < 0.7 * wantRange) {
		const bus = i2cRise(spec, c)
		const slow = bus.riseNs > 1000
		const strongest = Math.floor(1000 / (0.8473 * bus.busPf * 1e-12 * 1e9) / 100) * 100
		out.push({
			symptom: `/range_sensor_broadcaster/range at ${rangeHz.toFixed(1)} Hz; the sensor gives ${wantRange.toFixed(0)} Hz (its ${spec.sensor.updateMs} ms timing budget)`,
			cause: slow
				? `the I2C bus's rise time: ${(PULLUP_OHM / 1000).toFixed(0)} kΩ pull-ups on about ${bus.busPf.toFixed(0)} pF (the board, ${bus.devices} devices and a ${bus.cableMm} mm cable to the sensor, estimate ${CABLE_PF_PER_M} pF/m) rise in ${bus.riseNs.toFixed(0)} ns, over the 1000 ns standard mode allows: reads fail their ACK and retry`
				: `not the bus's rise time (${bus.riseNs.toFixed(0)} ns on about ${bus.busPf.toFixed(0)} pF is within 1000 ns): the firmware's loop or the link to the host is the next suspect`,
			fix: slow ? `stronger I2C pull-ups on the board: ${strongest} Ω or less, or a shorter sensor cable` : "check the control loop's timing and the console link (rule 2)",
			fields: slow ? ["parts", "mechanics"] : ["behavior"],
			affects: slow ? ["parts", "mechanics"] : ["firmware"],
			confidence: slow ? "measured" : "suspect",
		})
	}
	// 2. The wheel states' rate: the controller runs at the firmware's tick; the console must carry a report per tick.
	const jsHz = hz(m.topics["/joint_states"])
	if (jsHz !== undefined && jsHz < 0.7 * wantRange) {
		const baud = m.consoleBaud ?? 115200
		const bytesPerTick = 32 * 2 // one report out, one command in (about 32 bytes each)
		const maxHz = baud / 10 / bytesPerTick
		const linkBound = maxHz < 1.2 * wantRange
		out.push({
			symptom: `/joint_states at ${jsHz.toFixed(1)} Hz; the controller and the firmware tick at ${wantRange.toFixed(0)} Hz`,
			cause: linkBound
				? `the console link: ${baud} baud carries about ${maxHz.toFixed(0)} command-and-report pairs a second, too close to the ${wantRange.toFixed(0)} Hz tick`
				: `not the console's bandwidth (${baud} baud allows about ${maxHz.toFixed(0)} pairs/s): the host's load, or the firmware missing ticks`,
			fix: linkBound ? "a faster console (native USB on the MCU instead of a UART bridge), or fewer bytes per report" : "check the ROS host's CPU and the firmware's loop time",
			fields: linkBound ? ["parts", "pins"] : ["behavior"],
			affects: linkBound ? ["architect"] : ["firmware"],
			confidence: linkBound ? "measured" : "suspect",
		})
	}
	// 3. Speed: what the robot did against what was commanded (and what the design says the motors can give).
	if (m.achievedSpeedMps !== undefined && m.commandedSpeedMps !== undefined && m.achievedSpeedMps < 0.85 * m.commandedSpeedMps) {
		const top = maxWheelRadS(spec) * (spec.drive.wheelDiameterMm / 2000)
		const sagV = (spec.pack.internalOhm ?? 0.15) * spec.motor.stallA * 2
		out.push({
			symptom: `reached ${m.achievedSpeedMps.toFixed(2)} m/s of the ${m.commandedSpeedMps.toFixed(2)} m/s commanded`,
			cause:
				top < m.commandedSpeedMps * 1.1
					? `the motors' loaded top speed is only ${top.toFixed(2)} m/s on the cell's ${spec.pack.nominalV} V: no margin for load, slope or a sagging cell (up to ${sagV.toFixed(2)} V under two stalled motors, estimate)`
					: `the design allows ${top.toFixed(2)} m/s, so the shortfall is load the model doesn't hold (grip, rolling resistance, a heavier build) or the cell sagging ${sagV.toFixed(2)} V under load`,
			fix: top < m.commandedSpeedMps * 1.1 ? "a lower gear ratio or bigger wheels (mechanics), or a 2S pack" : "weigh the built robot and check the floor; re-run the drive with the measured mass",
			fields: ["mechanics"],
			affects: ["mechanics"],
			confidence: top < m.commandedSpeedMps * 1.1 ? "measured" : "suspect",
		})
	}
	return out
}

// `ros2 bag info` output to per-topic counts and the bag's duration.
export function bagStats(info: string): Record<string, TopicStats> {
	const dur = Number(/Duration:\s*([\d.]+)s/.exec(info)?.[1] ?? 0)
	const out: Record<string, TopicStats> = {}
	for (const m of info.matchAll(/Topic:\s*(\S+)\s*\|\s*Type:\s*\S+\s*\|\s*Count:\s*(\d+)/g)) out[m[1]] = { count: Number(m[2]), durationS: dur }
	return out
}
