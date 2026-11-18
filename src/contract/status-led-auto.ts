// A robot's status LED (real run 20b, Eurobot, 18 Nov 2026: the brief's "A status LED that shows ready, running, and
// stopped" was not delivered: no STATUS_LED pin, the only LED the charge LED; the review flagged it). The rover firmware
// always drives a pin named STATUS_LED (status_led.h: ready / running / stopped with a start cord, else a heartbeat),
// so every robot that drives on wheels gets one in code: the LED part (catalog role led, D<n>; its cathode resistor
// comes from the board generator) and STATUS_LED on a pin free at reset (unreservedGpios), leaving room for the
// quadrature channels the MCU move counts. No pin free: nothing changes (the MCU move decides the chip, not this).
// Pure; the contract tools apply it on a robot's parts and pins writes, with the MCU move.
import type { Part, PinAssignment } from "./types.ts"
import type { Mechanics, MotionTargets as Motion } from "../mechanics/types.ts"
import { mcuProfileOf } from "../mcu/profile.ts"
import { quadratureSignals, unreservedGpios } from "./mcu-move.ts"

type CatalogPart = Part & { lcsc: string | null }

export function withStatusLed(parts: Part[], pins: PinAssignment[], mechanics: Mechanics | null | undefined, motion: Motion | null | undefined, catalog: CatalogPart[]): { parts: Part[]; pins: PinAssignment[]; note: string } | null {
	if (!mechanics?.drive || pins.some((p) => p.signal === "STATUS_LED")) return null
	const prof = mcuProfileOf(parts)
	if (!prof) return null
	const used = new Set(pins.map((p) => p.gpio))
	const quadLeft = quadratureSignals(parts, motion ?? undefined).filter((q) => !pins.some((p) => p.signal === q.signal)).length
	const free = unreservedGpios(prof).filter((g) => !used.has(g))
	if (free.length <= quadLeft) return null
	const gpio = free[0]
	// An LED part no pin drives yet (the agent's own), else the catalog's.
	const driven = new Set(pins.map((p) => p.partRef))
	let led = parts.find((p) => p.role === "led" && p.pins.includes("A") && !driven.has(p.ref))
	let out = parts
	if (!led) {
		const entry = catalog.find((c) => c.role === "led")
		if (!entry) return null
		const taken = new Set(parts.map((p) => p.ref))
		let n = 1
		while (taken.has(`D${n}`)) n++
		const { ref: _r, ...rest } = entry as CatalogPart & Record<string, unknown>
		led = { ...(rest as unknown as Part), ref: `D${n}`, reason: "the robot's status LED: ready, running, stopped (the rover firmware drives STATUS_LED)" }
		out = [...parts, led]
	}
	const pinName = prof.pins.find((x) => x.index === gpio)?.name ?? `GPIO${gpio}`
	return {
		parts: out,
		pins: [...pins, { signal: "STATUS_LED", gpio, partRef: led.ref, partPin: "A" }],
		note: `STATUS_LED on ${pinName} drives ${led.ref} ${led.mpn}${out === parts ? "" : " (added)"}: the robot's ready / running / stopped light`,
	}
}
