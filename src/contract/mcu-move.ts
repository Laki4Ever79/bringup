// A robot that asks for wheel encoders counts both channels of each (quadrature: direction from the encoder, not from
// the duty). When its MCU can't carry every signal on pins that are free at reset, the MCU moves up to one that can,
// decided in code (lead decision, 17 Nov 2026, after real run 18: the ESP32-C3-MINI-1 has 8 unreserved GPIOs; the
// Eurobot base needs 9 with channel A only and 11 with both, so its pins went onto strapping pins GPIO2/8/9 and the USB
// pins, and an encoder's level at reset, set by where the wheel stopped, would pick the boot mode).
//   - the budget: the contract's GPIO signals other than USB (its pins are fixed by the chip), plus ENC_LB/ENC_RB for
//     the drive wheels' encoder plugs, against the MCU's pins that are not reserved (strap, USB, boot), not input-only
//     and not the console's;
//   - the new MCU: the best ranked (rankMcus) that fits, can be built, has hardware quadrature counters (PCNT), carries
//     the current MCU's radios and has a catalog part; it keeps the ref and any position the engineer gave;
//   - the pins follow: a pin on a GPIO the new chip reserves or lacks moves to a free one, USB goes to the new chip's
//     own USB pins, and ENC_LB/ENC_RB land on ENCB of JM1/JM2.
// Pure: the contract tools apply it after a robot's parts, pins, motion or mechanics write.
import type { Part, PinAssignment } from "./types.ts"
import type { MotionTargets as Motion } from "../mechanics/types.ts"
import { isEncoderPlug, MOTOR_PLUG_REFS } from "../mechanics/refs.ts"
import { loadProfiles, mcuProfileOf, type McuProfile } from "../mcu/profile.ts"
import { rankMcus } from "../mcu/select.ts"
import type { Need } from "../mcu/solver.ts"

const USB = /^USB_D[PN]$/

// The pins a design may take at will: not reserved (strap, USB, boot, ...), able to drive, not the console's.
export function unreservedGpios(p: McuProfile): number[] {
	const con = new Set(p.console ? [p.console.tx, p.console.rx] : [])
	const pref = p.preferred ?? []
	const rank = (i: number) => (pref.includes(i) ? pref.indexOf(i) : 100 + i)
	return p.pins.filter((x) => !x.reserved && !x.inputOnly && !con.has(x.name)).map((x) => x.index).sort((a, b) => rank(a) - rank(b))
}

// The quadrature channels a robot needs: one A and one B per drive-wheel encoder plug (JM1 left, JM2 right).
export function quadratureSignals(parts: Part[], motion: Pick<Motion, "encoders"> | undefined): { signal: string; partRef: string; partPin: "ENCA" | "ENCB" }[] {
	if (!motion?.encoders) return []
	return MOTOR_PLUG_REFS.slice(0, 2).flatMap((ref, i) => {
		const plug = parts.find((p) => p.ref === ref && isEncoderPlug(p))
		return plug ? (["A", "B"] as const).map((ch) => ({ signal: `ENC_${"LR"[i]}${ch}`, partRef: ref, partPin: `ENC${ch}` as "ENCA" | "ENCB" })) : []
	})
}

// The GPIO signals the design needs (USB aside), with the quadrature channels.
export function gpioBudget(parts: Part[], pins: PinAssignment[], motion: Pick<Motion, "encoders"> | undefined): string[] {
	const own = pins.filter((p) => typeof p.gpio === "number" && p.gpio >= 0 && !USB.test(p.signal)).map((p) => p.signal)
	return [...new Set([...own, ...quadratureSignals(parts, motion).map((q) => q.signal)])]
}

type CatalogMcu = Part & { lcsc: string | null }

export function moveUpMcu(parts: Part[], pins: PinAssignment[], motion: Motion | undefined, catalog: CatalogMcu[], profiles: McuProfile[] = loadProfiles()): { parts: Part[]; pins: PinAssignment[]; note: string } | null {
	const quad = quadratureSignals(parts, motion)
	const mcu = parts.find((p) => p.role === "mcu")
	const prof = mcuProfileOf(parts)
	if (!quad.length || !mcu || !prof) return null
	const budget = gpioBudget(parts, pins, motion)
	const room = unreservedGpios(prof).length
	if (budget.length <= room) return null
	const needs: Need[] = budget.map((signal) => ({ signal, kind: "gpio" }))
	const pick = rankMcus({ needs, radio: prof.radio.filter((r): r is "ble" | "wifi" => r === "ble" || r === "wifi") }, profiles)
		.map((r) => ({ r, p: profiles.find((x) => x.id === r.id)! }))
		.find(({ r, p }) => r.fits && r.buildable && p.peripherals.pcnt && unreservedGpios(p).length >= budget.length && catalog.some((c) => c.role === "mcu" && c.mpn === p.mpn))
	if (!pick) return null
	const to = pick.p
	const entry = catalog.find((c) => c.role === "mcu" && c.mpn === to.mpn)!
	const next: Part = { ...(entry as Part), ref: mcu.ref, ...(mcu.at ? { at: mcu.at } : {}), reason: `moved up from the ${mcu.mpn}: ${budget.length} signals need pins free at reset (${quad.map((q) => q.signal).join(", ")} for quadrature), it has ${room}; the ${to.mpn} has ${unreservedGpios(to).length} and hardware quadrature counters (PCNT)` }
	const outParts = parts.map((p) => (p === mcu ? next : p))
	// The pins: USB to the new chip's own, every other signal kept where the new chip leaves its pin free, the rest moved.
	const free = unreservedGpios(to)
	const usbIndex = (name: string) => to.pins.find((x) => x.name === name)?.index
	const out: PinAssignment[] = []
	const taken = new Set<number>()
	const moved: string[] = []
	for (const p of pins) {
		if (USB.test(p.signal) && to.usb) {
			const i = usbIndex(p.signal === "USB_DP" ? to.usb.dp : to.usb.dm)
			if (i !== undefined) {
				out.push({ ...p, gpio: i })
				taken.add(i)
				continue
			}
		}
		out.push({ ...p })
	}
	const keep = (p: PinAssignment) => free.includes(p.gpio) && !taken.has(p.gpio)
	for (const p of out) if (!USB.test(p.signal) && typeof p.gpio === "number" && p.gpio >= 0 && keep(p)) taken.add(p.gpio)
	const nextFree = () => free.find((i) => !taken.has(i))
	for (const p of out) {
		if (USB.test(p.signal) || typeof p.gpio !== "number" || p.gpio < 0) continue
		if (free.includes(p.gpio) && [...out].filter((q) => q.gpio === p.gpio).length === 1) continue
		const i = nextFree()
		if (i === undefined) return null
		moved.push(`${p.signal} GPIO${p.gpio} → GPIO${i}`)
		p.gpio = i
		taken.add(i)
	}
	for (const q of quad) {
		if (out.some((p) => p.signal === q.signal)) {
			const p = out.find((x) => x.signal === q.signal)!
			p.partRef = q.partRef
			p.partPin = q.partPin
			continue
		}
		const i = nextFree()
		if (i === undefined) return null
		out.push({ signal: q.signal, gpio: i, partRef: q.partRef, partPin: q.partPin })
		taken.add(i)
		moved.push(`${q.signal} on GPIO${i}`)
	}
	const note = `${mcu.ref} moved up from the ${mcu.mpn} to the ${to.mpn}: the robot's ${budget.length} signals (with ${quad.map((q) => q.signal).join(", ")} for quadrature) need pins free at reset, the ${mcu.mpn} has ${room}, the ${to.mpn} ${free.length} and hardware quadrature counters; pins: ${moved.join(", ") || "unchanged"}`
	return { parts: outParts, pins: out, note }
}
