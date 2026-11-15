// The drive parts' catalog (catalog/mechanics.json) and the board parts a rover needs (catalog/parts.json).
import { test } from "node:test"
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { byMpn, loadMechCatalog } from "../src/mechanics/catalog.ts"
import { loadCatalog } from "../src/tools/parts-search.ts"
import { PART_ROLES } from "../src/contract/types.ts"

const ROOT = resolve(import.meta.dirname, "..")

test("every number of every drive part has a source: a URL and where on it", () => {
	const cat = loadMechCatalog(ROOT)
	for (const list of [cat.sensors, cat.motors, cat.wheels, cat.casters, cat.batteries]) {
		assert.ok(list.length > 0)
		for (const part of list as unknown as Record<string, unknown>[]) {
			const source = part.source as Record<string, { url?: string; where?: string }>
			for (const [k, v] of Object.entries(part)) {
				// Numbers only: names, flags and the shop links ("buy": where to order, with live prices, not a datasheet value).
				if (k === "source" || k === "mpn" || k === "buy" || typeof v === "string" || typeof v === "boolean") continue
				assert.ok(source[k]?.url && source[k]?.where, `${part.mpn}: ${k} has no source`)
			}
		}
	}
})

test("the rover's motor driver grounds: pins, an LCSC number, and a source for each number", () => {
	assert.ok(PART_ROLES.includes("motor-driver" as never))
	const parts = loadCatalog(ROOT) as unknown as Record<string, unknown>[]
	for (const role of ["motor-driver"]) {
		const p = parts.find((x) => x.role === role)!
		assert.ok(p, role)
		assert.ok((p.pins as string[]).length > 0 && p.lcsc && p.footprint)
		const source = p.source as Record<string, unknown>
		const numbers = Object.entries(p).filter(([, v]) => typeof v === "number").map(([k]) => k)
		for (const k of numbers) assert.ok(source[k], `${p.mpn}: ${k} has no source`)
	}
})

// Real rover run 2 (15 Nov): the mechanics engineer wrote the part number alone, and every lookup failed.
test("a catalog part is found by its part number alone when that names exactly one part", () => {
	const m = loadMechCatalog(resolve(import.meta.dirname, ".."))
	assert.equal(byMpn(m.motors, "POLOLU-2366")?.mpn, "POLOLU-2366 75:1 MP 6V")
	assert.equal(byMpn(m.wheels, "pololu-1430")?.mpn, "POLOLU-1430 wheel 80x10 mm")
	assert.equal(byMpn(m.batteries, "ADAFRUIT-2011")?.mpn, "ADAFRUIT-2011 LP-803860 2000 mAh")
	assert.equal(byMpn(m.motors, "POLOLU-2367 100:1 MP 6V")?.mpn, "POLOLU-2367 100:1 MP 6V", "the full mpn still works")
	assert.equal(byMpn(m.motors, "POLOLU"), undefined, "a prefix of several parts names none")
	assert.equal(byMpn(m.motors, "POLOLU-9999"), undefined)
})
