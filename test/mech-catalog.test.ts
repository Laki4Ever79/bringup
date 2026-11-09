// The drive parts' catalog (catalog/mechanics.json) and the board parts a rover needs (catalog/parts.json).
import { test } from "node:test"
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { loadMechCatalog } from "../src/mechanics/catalog.ts"
import { loadCatalog } from "../src/tools/parts-search.ts"
import { PART_ROLES } from "../src/contract/types.ts"

const ROOT = resolve(import.meta.dirname, "..")

test("every number of every drive part has a source: a URL and where on it", () => {
	const cat = loadMechCatalog(ROOT)
	for (const list of [cat.motors, cat.wheels, cat.casters, cat.batteries]) {
		assert.ok(list.length > 0)
		for (const part of list as unknown as Record<string, unknown>[]) {
			const source = part.source as Record<string, { url?: string; where?: string }>
			for (const [k, v] of Object.entries(part)) {
				if (k === "source" || k === "mpn" || typeof v === "string" || typeof v === "boolean") continue
				assert.ok(source[k]?.url && source[k]?.where, `${part.mpn}: ${k} has no source`)
			}
		}
	}
})

test("the rover's board parts ground: a motor driver and a distance sensor with pins, LCSC numbers and sources", () => {
	assert.ok(PART_ROLES.includes("motor-driver" as never) && PART_ROLES.includes("tof-sensor" as never))
	const parts = loadCatalog(ROOT) as unknown as Record<string, unknown>[]
	for (const role of ["motor-driver", "tof-sensor"]) {
		const p = parts.find((x) => x.role === role)!
		assert.ok(p, role)
		assert.ok((p.pins as string[]).length > 0 && p.lcsc && p.footprint)
		const source = p.source as Record<string, unknown>
		const numbers = Object.entries(p).filter(([, v]) => typeof v === "number").map(([k]) => k)
		for (const k of numbers) assert.ok(source[k], `${p.mpn}: ${k} has no source`)
	}
})
