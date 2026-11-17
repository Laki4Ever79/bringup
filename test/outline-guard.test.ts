// Real run 20 (Eurobot, 17 Nov 2026) ended 85% over its smallest board: at rev 20 a doubled power tree left no spot for U8 at
// 46×38; after the doubles were removed the architect still grew the board to 56×46, citing that placement failure as
// "routing". Two plain-code rules: an outline that doesn't place is refused before it becomes a revision, naming sizes that
// do; and a "routing" size reason holds only when a build of this design failed to route.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { outlineRefusal } from "../src/agents/contract-tools.ts"
import { recordRoutingFailure, spaceChecks, placesAll } from "../src/contract/space.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

const fixture = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8")) as ContractSnapshot

test("an outline that can't hold what the board carries is refused, naming nearby sizes that place", () => {
	const s = fixture("cc-eurobot20-rev20.json")
	const r = outlineRefusal(s, { ...s.values.outline!, widthMm: 46, heightMm: 38 })!
	assert.match(r, /a 46×38 mm board has no spot for everything it carries.*sizes near it that place: (\d+×\d+(, )?)+ mm; the smallest: \d+×\d+ mm/)
	// Every size it names places.
	for (const m of r.match(/sizes near it that place: ([^;]+) mm/)![1].split(", ")) {
		const [w, h] = m.split("×").map(Number)
		assert.equal(placesAll(s, w, h), true, m)
	}
	// A size that places goes through; so does the first outline (nothing placed yet).
	assert.equal(outlineRefusal(s, { ...s.values.outline!, widthMm: 56, heightMm: 46 }), null)
	assert.equal(outlineRefusal({ ...s, values: { ...s.values, outline: undefined } }, { ...s.values.outline!, widthMm: 10, heightMm: 10 }), null)
})

test("a routing size reason holds only when a build of the design failed to route", () => {
	const s = fixture("cc-eurobot20-rev24.json")
	assert.equal(s.values.outline!.sizeReason?.kind, "routing")
	assert.deepEqual(spaceChecks(s).map((v) => v.kind), ["space-slack"])
	recordRoutingFailure(s, 50, 41)
	assert.deepEqual(spaceChecks(s), [])
})
