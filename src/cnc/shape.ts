import { CNC_AXES } from "./types.ts"

// The shapes the contract accepts for cncTargets and cnc (contract.ts shapeError): what an agent must write.
const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const num = (v: unknown, min = -Infinity) => typeof v === "number" && Number.isFinite(v) && v >= min
const pos = (v: unknown) => num(v) && (v as number) > 0
const pair = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every(pos)
const str = (v: unknown) => typeof v === "string" && v !== ""

export const CNC_TARGETS_SHAPE =
	"cncTargets must be {travelMm: {x, y, z} > 0 (the work area), footprintMm: [width, depth] > 0 (the most the frame may take), rapidMmMin > 0, feedMmMin > 0, cut: {material, depthMm > 0, toolMm > 0} (one pass), spindleW > 0 (at most), repeatMm > 0} (mm)"

export function cncTargetsShapeError(v: unknown): string | null {
	if (!obj(v) || !obj(v.travelMm) || !obj(v.cut)) return CNC_TARGETS_SHAPE
	const t = v.travelMm, c = v.cut
	const ok = pos(t.x) && pos(t.y) && pos(t.z) && pair(v.footprintMm) && pos(v.rapidMmMin) && pos(v.feedMmMin) && str(c.material) && pos(c.depthMm) && pos(c.toolMm) && pos(v.spindleW) && pos(v.repeatMm)
	return ok ? null : CNC_TARGETS_SHAPE
}

export const CNC_SHAPE = `cnc must be {axes: exactly ${CNC_AXES.length} in this order: ${CNC_AXES.join(", ")}, each {name, motor (catalog/mechanics.json steppers mpn), motors: 1|2 (2: a gantry driven at both ends), screw (driveTrain lead screw mpn), rail (rails mpn), travelMm > 0, homeAt: "min"|"max", driver: {currentA > 0 (RMS), microsteps (1..256, a power of 2), uartAddr (0..3, unique)}}, spindle: {part (spindles mpn), volts > 0, watts > 0}, estop (safety mpn), input: {kind: "dc-brick", volts, amps}, frame: {footprintMm: [width, depth], heightMm}, boards: [{name, at: {xMm, yMm}, rotDeg: 0|90|180|270}], firmware: "fluidnc"|"grblhal"} (mm)`

export function cncShapeError(v: unknown): string | null {
	if (!obj(v) || !Array.isArray(v.axes) || !obj(v.spindle) || !obj(v.input) || !obj(v.frame) || !Array.isArray(v.boards)) return CNC_SHAPE
	const names = v.axes.map((a) => (obj(a) ? a.name : undefined))
	if (names.length !== CNC_AXES.length || names.some((n, i) => n !== CNC_AXES[i])) return `${CNC_SHAPE}; its axes are ${names.join(", ")}`
	for (const a of v.axes as Record<string, unknown>[]) {
		const d = a.driver
		const micro = obj(d) && Number.isInteger(d.microsteps) && (d.microsteps as number) >= 1 && (d.microsteps as number) <= 256 && ((d.microsteps as number) & ((d.microsteps as number) - 1)) === 0
		const ok = str(a.motor) && (a.motors === 1 || a.motors === 2) && str(a.screw) && str(a.rail) && pos(a.travelMm) && (a.homeAt === "min" || a.homeAt === "max") && obj(d) && pos(d.currentA) && micro && Number.isInteger(d.uartAddr) && (d.uartAddr as number) >= 0 && (d.uartAddr as number) <= 3
		if (!ok) return `${CNC_SHAPE}; axis ${a.name} is wrong`
	}
	const addrs = (v.axes as { driver: { uartAddr: number } }[]).map((a) => a.driver.uartAddr)
	if (new Set(addrs).size !== addrs.length) return `${CNC_SHAPE}; two drivers share a UART address (${addrs.join(", ")})`
	const s = v.spindle
	if (!(str(s.part) && pos(s.volts) && pos(s.watts))) return `${CNC_SHAPE}; its spindle is wrong`
	if (!str(v.estop)) return `${CNC_SHAPE}; it needs an estop`
	const i = v.input
	if (!(i.kind === "dc-brick" && pos(i.volts) && pos(i.amps))) return `${CNC_SHAPE}; its input is wrong`
	const f = v.frame
	if (!(pair(f.footprintMm) && pos(f.heightMm))) return `${CNC_SHAPE}; its frame is wrong`
	const at = (p: unknown) => obj(p) && num(p.xMm) && num(p.yMm)
	if (!v.boards.every((x) => obj(x) && typeof x.name === "string" && at(x.at) && [0, 90, 180, 270].includes(x.rotDeg as number))) return `${CNC_SHAPE}; its boards are wrong`
	if (v.firmware !== "fluidnc" && v.firmware !== "grblhal") return `${CNC_SHAPE}; firmware must be "fluidnc" or "grblhal"`
	return null
}
