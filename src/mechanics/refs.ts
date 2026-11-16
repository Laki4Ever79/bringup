import type { Part } from "../contract/types.ts"

// A robot's plugs have fixed names, set here, never chosen by an agent (rover run cc-rover-4 on the Claude
// subscription, 15 Nov 2026: the parts agent, the architect and the mechanics renamed the motor and sensor plugs JM1, JM2,
// JT1, JMOT1, JMOT2 in turn for 30 revisions, each following the other's last change). The distance sensor's 4-pin plug
// is JT1 (mechanics.sensor.connector); the two motors' 2-pin plugs are JM1 and JM2.
export const SENSOR_PLUG_REF = "JT1"
export const MOTOR_PLUG_REFS = ["JM1", "JM2"] as const

export const isSensorPlug = (p: Part) => p.role === "connector" && p.pins.length === 4
// A motor's plug: 2-pin (pins 1, 2), or an encoder gearmotor's 6-pin (M1, M2, its encoder's VCC, GND, ENCA, ENCB).
export const isEncoderPlug = (p: Part) => p.role === "connector" && ["M1", "M2", "ENCA", "ENCB", "VCC", "GND"].every((x) => p.pins.includes(x))
export const isMotorPlug = (p: Part) => (p.role === "connector" && p.pins.length === 2 && p.pins[0] === "1" && p.pins[1] === "2") || isEncoderPlug(p)

// The parts with the robot's plugs under their fixed names, and old ref → new ref for each one renamed (empty when none
// is). A part that holds one of the names but isn't that plug gets the next free J<n>.
export function robotRefs(parts: Part[]): { parts: Part[]; renames: Record<string, string> } {
	const sensor = parts.find((p) => isSensorPlug(p) && p.ref === SENSOR_PLUG_REF) ?? parts.find(isSensorPlug)
	const motors = parts.filter(isMotorPlug).sort((a, b) => rank(a.ref) - rank(b.ref)).slice(0, 2)
	const want = new Map<Part, string>()
	if (sensor) want.set(sensor, SENSOR_PLUG_REF)
	motors.forEach((m, i) => want.set(m, MOTOR_PLUG_REFS[i]))
	const fixed = new Set(want.values())
	const used = new Set(parts.map((p) => p.ref))
	const renames: Record<string, string> = {}
	const free = () => {
		for (let n = 2; ; n++) if (!used.has(`J${n}`) && !fixed.has(`J${n}`)) return used.add(`J${n}`), `J${n}`
	}
	const out = parts.map((p) => {
		const to = want.get(p) ?? (fixed.has(p.ref) ? free() : p.ref)
		if (to !== p.ref) renames[p.ref] = to
		return to === p.ref ? p : { ...p, ref: to }
	})
	return { parts: out, renames }
}

// Already-fixed names first, so a plug that has its name keeps it.
const rank = (ref: string) => (MOTOR_PLUG_REFS as readonly string[]).indexOf(ref) >= 0 ? (MOTOR_PLUG_REFS as readonly string[]).indexOf(ref) : 10

// The connectors with each one that names no part (or repeats a ref) given to a plug part that has no connector yet, in
// order (rover run cc-rover-4: the architect placed JT1 and JM2 while the parts list called them JMOT1 and JMOT2, and
// each side renamed to the other's last names). Null when nothing changes.
export function connectorsForParts<K extends { ref: string }>(connectors: K[], parts: Part[]): K[] | null {
	const refs = new Set(parts.map((p) => p.ref))
	const placed = new Set(connectors.map((k) => k.ref).filter((r) => refs.has(r)))
	const missing = parts.filter((p) => (isSensorPlug(p) || isMotorPlug(p)) && !placed.has(p.ref)).map((p) => p.ref)
	const seen = new Set<string>()
	let changed = false
	const out = connectors.map((k) => {
		const stale = !refs.has(k.ref) || seen.has(k.ref)
		seen.add(k.ref)
		if (!stale || missing.length === 0) return k
		changed = true
		const ref = missing.shift()!
		seen.add(ref)
		return { ...k, ref }
	})
	return changed ? out : null
}
