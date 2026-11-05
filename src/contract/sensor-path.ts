// The sensor path a model's training data travels: which part hears or feels the world, where the board puts it and
// how it is turned, what the case puts in front of it, and how the firmware samples it. A model is only as good as the
// match between the path its data was recorded on and the device it runs on. Bringup computes the path from the
// contract, so a board or case change that moves it shows up as a different hash, and the model's data goes stale.
import { createHash } from "node:crypto"
import { micPorts, placedByRole } from "../codegen/circuit.ts"
import { PORT_MM } from "../tools/enclosure.ts"
import type { ContractSnapshot, ModelSpec, Part } from "./types.ts"

// How the data-collection firmware reads a microphone (model.h MIC_*): the ICS-43434 puts 24-bit samples MSB-first in a
// 32-bit I2S slot (DS-000069 Rev 1.2, "I2S Data Interface"); keeping the top 16 bits is a fixed digital gain, so it is
// part of the path, as is the channel the LR pin selects (tied low: left).
export const MIC_CAPTURE = { slotBits: 32, sampleBits: 16, shift: 16, channel: "left" } as const
// The case floor under the board (py/enclosure.py: wall and floor are both 2 mm). Its thickness is the length of the
// opening's tube in front of the microphone.
export const FLOOR_MM = 2

// The sensor parts a model can read, by its kind.
export const SENSOR_ROLE: Record<ModelSpec["sensor"], Part["role"][]> = { microphone: ["microphone"], motion: ["sensor"], camera: ["other"] }

export interface SensorPath {
	sensor: ModelSpec["sensor"]
	mpn: string
	// The part on the board: centre from the board's bottom-left corner, mm, and its rotation, degrees.
	xMm: number
	yMm: number
	rotation: number
	// What sits in front of a bottom-port microphone: the opening through the case floor.
	opening?: { diameterMm: number; floorMm: number }
	sampleRateHz: number
	channels: number
	capture?: typeof MIC_CAPTURE
}

const mm = (x: number) => Math.round(x * 10) / 10

// The path from the contract, or null when the model has no sensor part to read yet.
export function sensorPath(s: ContractSnapshot): SensorPath | null {
	const m = s.values.model
	if (!m) return null
	const roles = SENSOR_ROLE[m.sensor]
	const part = (s.values.parts ?? []).find((p) => roles.includes(p.role))
	if (!part) return null
	const at = roles.flatMap((r) => placedByRole(s, r)).find((p) => p.ref === part.ref)
	const path: SensorPath = { sensor: m.sensor, mpn: part.mpn, xMm: mm(at?.xMm ?? NaN), yMm: mm(at?.yMm ?? NaN), rotation: at?.rotation ?? 0, sampleRateHz: m.sampleRateHz, channels: m.channels }
	if (m.sensor === "microphone") {
		if (micPorts(s).some((p) => p.ref === part.ref)) path.opening = { diameterMm: PORT_MM, floorMm: FLOOR_MM }
		path.capture = MIC_CAPTURE
	}
	return path
}

// Twelve hex digits of the path's SHA-256, over its keys in a fixed order. The firmware stamps it on every recording.
export function pathHash(p: SensorPath): string {
	const canonical = (v: unknown): unknown =>
		v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v
	return createHash("sha256").update(JSON.stringify(canonical(p))).digest("hex").slice(0, 12)
}

// What differs between two paths, in words: "mpn ICS-43434 → X", "xMm 40.5 → 30.5".
export function pathDiff(from: SensorPath, to: SensorPath): string[] {
	const flat = (p: SensorPath) => {
		const out: Record<string, string> = {}
		const walk = (v: unknown, key: string) => {
			if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, key ? `${key}.${k}` : k)
			else out[key] = String(v)
		}
		walk(p, "")
		return out
	}
	const [a, b] = [flat(from), flat(to)]
	return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).map((k) => `${k} ${a[k] ?? "none"} → ${b[k] ?? "none"}`)
}
