// Every role the catalog uses is a part role the contract accepts: real run 17 (Eurobot, 16 Nov 2026) had to add the
// power tree's ideal diode and Schottky as "other" (diode and ideal-diode were missing), so the power tree never saw them.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { PART_ROLES } from "../src/contract/types.ts"

test("every catalog part role is one the contract accepts", () => {
	const parts = JSON.parse(readFileSync(new URL("../catalog/parts.json", import.meta.url), "utf8")) as { role: string; mpn: string }[]
	const bad = parts.filter((p) => !(PART_ROLES as readonly string[]).includes(p.role)).map((p) => `${p.mpn}: ${p.role}`)
	assert.deepEqual(bad, [])
})
