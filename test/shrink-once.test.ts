// The board shrinks once, when what it carries is settled (17 Nov 2026): real run 20b compacted to 38×44 at rev 17, then
// JT1 (rev 18) and the servo outputs (rev 25) arrived, and the outline chased them 6 more times. While a finding still
// asks for parts or connectors, "too big" waits; "too small" never does.
import { test } from "node:test"
import assert from "node:assert/strict"
import { checkConsistency } from "../src/contract/consistency.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { fixtureContract } from "./fixture.ts"

const logger = () => {
	const s = fixtureContract()
	const { sizeReason: _r, ...outline } = structuredClone(LOGGER_DESIGN.outline)
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN), outline: { ...outline, widthMm: 50, heightMm: 30 } }
	return s
}

test("too big waits while the parts list is still asked for; it comes back once it is settled", () => {
	const s = logger()
	assert.ok(checkConsistency(s, {}).some((v) => v.kind === "space-slack"))
	// A pin on a part the list doesn't have: a parts finding is open.
	const open = { ...s, values: { ...s.values, pins: [...s.values.pins!, { signal: "EXTRA", gpio: 3, partRef: "U9", partPin: "IN" }] } }
	const v = checkConsistency(open, {})
	assert.ok(v.some((x) => x.fields.includes("parts")), v.map((x) => x.kind).join(", "))
	assert.ok(!v.some((x) => x.kind === "space-slack" && x.fields.includes("outline")), "held while parts are asked for")
})
