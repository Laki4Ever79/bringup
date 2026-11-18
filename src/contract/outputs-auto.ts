// A robot's PWM driver comes with what it drives (real run 20b, Eurobot, 18 Nov 2026: the parts agent added the
// PCA9685 U6 for the brief's "spare motor output and two servo outputs" and nothing it drives; the review found "no servo
// or motor header and no servo supply", and the firmware report said "0 servo(s)"). The general cause: a driver part
// added without its outputs. In code, as the IMU and the power tree are, so it lands in the same write:
//   - two servo plugs (catalog role servo) on its channels 0 and 1, JV1 and JV2 (circuit.ts servoOutputs wires two);
//   - the servos' 5 V supply (catalog role servo-supply): the module entry, which assemblableSupplies (power-auto.ts)
//     then turns into the chip JLCPCB assembles for that many servos at stall;
//   - on a differential base, the spare motor: a second motor driver (inputs from channels 2 and 3) and a third motor
//     plug like the drive's (JM3). A skid-steer base's second driver is its rear pair, so it gets no spare.
// Pure; the contract tools apply it on a robot's parts, motion and mechanics writes.
import type { Part } from "./types.ts"
import type { Mechanics } from "../mechanics/types.ts"
import { isMotorPlug } from "../mechanics/refs.ts"

type CatalogPart = Part & { lcsc: string | null }
export const SERVO_PLUG_REFS = ["JV1", "JV2"] as const

export function withDriverOutputs(parts: Part[], catalog: CatalogPart[], mechanics: Mechanics | null | undefined): { parts: Part[]; note: string | null } {
	const pwm = parts.find((p) => p.role === "pwm-driver")
	if (!pwm) return { parts, note: null }
	const taken = new Set(parts.map((p) => p.ref))
	const freeU = () => {
		let n = 2
		while (taken.has(`U${n}`)) n++
		taken.add(`U${n}`)
		return `U${n}`
	}
	const strip = (e: CatalogPart): Part => {
		const { ref: _r, ...rest } = e as CatalogPart & Record<string, unknown>
		return rest as unknown as Part
	}
	const added: Part[] = []
	const notes: string[] = []
	const servo = catalog.find((c) => c.role === "servo")
	const have = parts.filter((p) => p.role === "servo").length
	if (servo && have < SERVO_PLUG_REFS.length) {
		const refs = SERVO_PLUG_REFS.filter((r) => !taken.has(r)).slice(0, SERVO_PLUG_REFS.length - have)
		for (const ref of refs) {
			taken.add(ref)
			added.push({ ...strip(servo), ref, reason: `the PWM driver ${pwm.ref}'s servo output (channel ${SERVO_PLUG_REFS.indexOf(ref)}): a hobby servo's 3-pin plug, +5 V from the servo supply` })
		}
		if (refs.length) notes.push(`${refs.join(" and ")} ${servo.mpn} (servo plugs on ${pwm.ref} channels 0-1)`)
	}
	// The module entry (no LCSC number): power-auto.ts assemblableSupplies picks the chip for the servo count.
	const supply = catalog.find((c) => c.role === "servo-supply" && !c.lcsc) ?? catalog.find((c) => c.role === "servo-supply")
	if (supply && !parts.some((p) => p.role === "servo-supply")) {
		const ref = freeU()
		added.push({ ...strip(supply), ref, reason: `the servos' 5 V on ${pwm.ref}'s outputs, from the pack, off when the emergency stop opens (its EN)` })
		notes.push(`${ref} ${supply.mpn} (the servos' 5 V supply)`)
	}
	const drivers = parts.filter((p) => p.role === "motor-driver")
	if (mechanics?.drive && mechanics.drive.kind !== "skid4" && drivers.length === 1) {
		const ref = freeU()
		added.push({ ...drivers[0], ref, at: undefined, reason: `the spare motor output: a second ${drivers[0].mpn}, its channel A on ${pwm.ref} channels 2-3` } as Part)
		const plugs = parts.filter(isMotorPlug)
		const plug = plugs.find((p) => p.ref === "JM1") ?? plugs[0]
		if (plug && plugs.length < 3 && !taken.has("JM3")) {
			taken.add("JM3")
			added.push({ ...plug, ref: "JM3", at: undefined, reason: `the spare motor's plug (${ref} channel A), the drive motors' ${plug.mpn}` } as Part)
			notes.push(`${ref} ${drivers[0].mpn} and JM3 ${plug.mpn} (the spare motor output)`)
		} else notes.push(`${ref} ${drivers[0].mpn} (the spare motor's driver)`)
	}
	if (!added.length) return { parts, note: null }
	const clean = added.map((p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) as unknown as Part)
	return { parts: [...parts, ...clean], note: `the PWM driver ${pwm.ref} gets what it drives: added ${notes.join("; ")}` }
}
