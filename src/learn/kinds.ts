import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"

// Facts no part may be learned without (the spec's critical list): never a default, never a guess. `mountHoles`
// applies only to kinds that have mount holes, the supply limits only to powered kinds, `footprint` only to parts
// soldered on the board.
export const GENERIC_CRITICAL: readonly string[] = ["outline", "height", "mountHoles", "pins", "supplyMaxV", "supplyRange", "footprint"]

const Kind = z.object({
	kind: z.string().min(1),
	placement: z.enum(["board", "case"]),
	// Whether parts of this kind are held by mount holes (a speaker driver) rather than by their solder joints.
	mountHoles: z.boolean(),
	// Whether parts of this kind take a supply voltage (an IC) rather than none (a resistor, a connector).
	powered: z.boolean(),
	fields: z.array(z.object({ field: z.string(), unit: z.string().optional(), what: z.string() })),
	// Added to the generic list; a kind can never remove a generic critical field.
	critical: z.array(z.string()),
	defaults: z.record(z.string(), z.object({ value: z.union([z.number(), z.string()]), reason: z.string().min(1) })),
	calculated: z.record(z.string(), z.object({ formula: z.string(), inputs: z.array(z.string()) })),
	// What the case placer must give a case part (e.g. "grille", "back-volume", "keep-out:microphone").
	needs: z.array(z.string()).optional(),
})
export type KindFile = z.infer<typeof Kind>

export function criticalFields(kind: KindFile): string[] {
	const generic = GENERIC_CRITICAL.filter(
		(f) => !(f === "footprint" && kind.placement === "case") && !(f === "mountHoles" && !kind.mountHoles) && !((f === "supplyMaxV" || f === "supplyRange") && !kind.powered),
	)
	return [...new Set([...generic, ...kind.critical])]
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
