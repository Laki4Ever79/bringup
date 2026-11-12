import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { CatalogPart } from "../tools/parts-search.ts"
import type { LearnedPart } from "./types.ts"

// Learned parts live one per file in catalog/learned/ (committed: facts and where they came from, never the documents
// themselves), merged into the catalog by loadCatalog.
export const learnedDir = (root: string) => join(root, "catalog/learned")

// A safe file name for any MPN: lower case, anything outside [a-z0-9._-] made "_", plus a short hash of the MPN
// itself so names that sanitize alike ("A/B", "A_B") stay apart.
export function learnedFileName(mpn: string): string {
	const safe = mpn.toLowerCase().replace(/[^a-z0-9._-]/g, "_").replace(/^\.+/, "_")
	return `${safe}-${createHash("sha256").update(mpn).digest("hex").slice(0, 8)}.json`
}

export function readLearned(root: string): LearnedPart[] {
	const dir = learnedDir(root)
	if (!existsSync(dir)) return []
	const out: LearnedPart[] = []
	for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
		try {
			const p = JSON.parse(readFileSync(join(dir, name), "utf8")) as LearnedPart
			if (typeof p?.mpn !== "string" || !Array.isArray(p.facts)) throw new Error("not a learned part")
			out.push(p)
		} catch (e) {
			console.error(`[learn] skipped catalog/learned/${name}: ${e instanceof Error ? e.message : e}`)
		}
	}
	return out
}

// Written whole or not at all (a temp file renamed over), so a reader never sees half a part.
export function writeLearned(root: string, part: LearnedPart): string {
	const dir = learnedDir(root)
	mkdirSync(dir, { recursive: true })
	const path = join(dir, learnedFileName(part.mpn))
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
	writeFileSync(tmp, JSON.stringify(part, null, "\t") + "\n")
	renameSync(tmp, path)
	return path
}

const factValue = (part: LearnedPart, field: string) => part.facts.find((f) => f.field === field)?.value

// A learned part as the rest of Bringup sees catalog parts. Pins are stored as one comma-separated fact value.
export function toCatalogPart(part: LearnedPart): CatalogPart {
	const pins = factValue(part, "pins")
	const footprint = factValue(part, "footprint")
	const lcsc = part.orderFrom.find((l) => l.distributor === "lcsc")?.sku ?? null
	const doc = part.documents[0]
	return {
		role: part.role,
		mpn: part.mpn,
		lcsc,
		footprint: typeof footprint === "string" ? footprint : "",
		pins: typeof pins === "string" ? pins.split(",").map((p) => p.trim()).filter(Boolean) : [],
		notes: `Learned by Bringup ${part.learnedAt.slice(0, 10)}${doc ? ` from ${doc.url}` : ""}; every number's source is in catalog/learned/${learnedFileName(part.mpn)}.`,
		stock: null,
		priceUsd: null,
		inStock: null,
	}
}
