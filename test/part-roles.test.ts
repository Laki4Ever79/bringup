// Every role the catalog's parts carry is one the contract accepts (26 Nov 2026: a CNC branch added the TMC2209-LA to
// catalog/parts.json as a stepper-driver, and the contract refused the parts list with it until PART_ROLES named the role).
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { PART_ROLES } from "../src/contract/types.ts"

test("every role in catalog/parts.json is in PART_ROLES", () => {
	const parts = JSON.parse(readFileSync(join(import.meta.dirname, "../catalog/parts.json"), "utf8")) as { role: string; mpn: string }[]
	const unknown = parts.filter((p) => !(PART_ROLES as readonly string[]).includes(p.role)).map((p) => `${p.mpn}: ${p.role}`)
	assert.deepEqual(unknown, [])
})
