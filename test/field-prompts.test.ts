// Every contract field the code checks reaches its owner's prompt (26 Nov 2026: mechanics.drive.turnScale and
// maxAccelMps2 were checked in src/mechanics/shape.ts but missing from MECHANICS_SHAPE, the text the mechanics
// engineer is given, so a change request naming them had nothing to land on).
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { MECHANICS_SHAPE } from "../src/mechanics/shape.ts"

test("each mechanics key the shape check reads is named in MECHANICS_SHAPE, the mechanics engineer's field list", () => {
	const src = readFileSync(resolve(import.meta.dirname, "../src/mechanics/shape.ts"), "utf8")
	const body = src.slice(src.indexOf("export function mechanicsShapeError"))
	// The check's own names for the sub-objects: v (mechanics), d (drive), b (battery), c (chassis), s (sensor).
	const keys = new Set([...body.matchAll(/\b[vdbcs]\.([a-zA-Z]\w*)\b/g)].map((m) => m[1]))
	const missing = [...keys].filter((k) => !new RegExp(`\\b${k}\\b`).test(MECHANICS_SHAPE))
	assert.deepEqual(missing, [], `checked but not in the prompt: ${missing.join(", ")}`)
})
