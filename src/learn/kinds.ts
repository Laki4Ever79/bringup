import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"

// Facts no part may be learned without (the spec's critical list): never a default, never a guess. `mountHoles`
// applies only to kinds that have mount holes, the supply limits only to powered kinds, `footprint` only to parts
// soldered on the board.
export const GENERIC_CRITICAL: readonly string[] = ["outline", "height", "mountHoles", "pins", "supplyMaxV", "supplyRange", "footprint"]

const Kind = z.object({
	kind: z.string().min(1),
	// What the part is, in plain words, for the models that propose and identify parts: a kind's name alone misleads
	// ("speaker-driver" reads as a driver IC).
	description: z.string().min(1).optional(),
	placement: z.enum(["board", "case"]),
	fields: z.array(z.object({ field: z.string(), unit: z.string().optional(), what: z.string() })),
	// Added to the generic list; a kind can never remove a generic critical field.
	critical: z.array(z.string()),
	defaults: z.record(z.string(), z.object({ value: z.union([z.number(), z.string()]), reason: z.string().min(1) })),
	calculated: z.record(z.string(), z.object({ formula: z.string(), inputs: z.array(z.string()) })),
	// What the case placer must give a case part (e.g. "grille", "back-volume", "keep-out:microphone").
	needs: z.array(z.string()).optional(),
})
export type KindFile = z.infer<typeof Kind>

// The only exemptions from the generic list, kept here in code rather than in kind files: a kind file (which the
// learner may draft for a new kind) can make learning stricter, never looser. Kinds soldered by their pins have no
// mount holes, nor do speakers: small ones have none (adhesive, a flange), so the case clamps them by the rim their
// outline gives (the kind's "clamp-rim" need). Passive parts and connectors take no supply. Any kind not named here
// needs every generic fact.
const NO_MOUNT_HOLES = new Set(["amplifier", "battery", "button", "capacitor", "charge-led", "charger", "connector", "ldo", "led", "mcu", "microphone", "motor-driver", "resistor", "sensor", "speaker-driver", "usb-c"])
const UNPOWERED = new Set(["battery", "button", "capacitor", "charge-led", "connector", "led", "resistor", "speaker-driver", "usb-c"])

export function criticalFields(kind: KindFile): string[] {
	const generic = GENERIC_CRITICAL.filter(
		(f) => !(f === "footprint" && kind.placement === "case") && !(f === "mountHoles" && NO_MOUNT_HOLES.has(kind.kind)) && !((f === "supplyMaxV" || f === "supplyRange") && UNPOWERED.has(kind.kind)),
	)
	return [...new Set([...generic, ...kind.critical])]
}

const GENERIC_WHAT: Record<string, { unit?: string; what: string }> = {
	outline: { unit: "mm", what: "body width × length (or diameter × depth for round parts)" },
	height: { unit: "mm", what: "body height above the board or mounting face" },
	mountHoles: { unit: "mm", what: "mount holes: count, diameter and their positions or pitch" },
	pins: { what: "pin names in pin-number order" },
	supplyMaxV: { unit: "V", what: "absolute maximum supply voltage" },
	supplyRange: { unit: "V", what: "recommended operating supply range [min, max]" },
}

// What the reader is asked for: the kind's own fields plus every critical one it doesn't list, never the footprint
// (that comes from a land-pattern library, footprint.ts).
export function fieldsToRead(kind: KindFile): KindFile["fields"] {
	const listed = kind.fields.filter((f) => f.field !== "footprint")
	const missing = criticalFields(kind)
		.filter((f) => f !== "footprint" && !listed.some((x) => x.field === f))
		.map((f) => ({ field: f, ...(GENERIC_WHAT[f] ?? { what: f }) }))
	return [...listed, ...missing]
}

// Every catalog/kinds/*.json, checked. A bad file throws, naming it: a kind file that quietly failed to load would
// make its parts unlearnable without saying why.
export function loadKinds(root: string): Map<string, KindFile> {
	const dir = join(root, "catalog/kinds")
	const out = new Map<string, KindFile>()
	for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
		let kind: KindFile
		try {
			kind = Kind.parse(JSON.parse(readFileSync(join(dir, name), "utf8")))
		} catch (e) {
			throw new Error(`catalog/kinds/${name}: ${e instanceof Error ? e.message : e}`)
		}
		const critical = new Set([...GENERIC_CRITICAL, ...kind.critical])
		const bad = Object.keys(kind.defaults).filter((f) => critical.has(f))
		if (bad.length) throw new Error(`catalog/kinds/${name}: a default on a critical field (${bad.join(", ")}) is not allowed`)
		out.set(kind.kind, kind)
	}
	return out
}
