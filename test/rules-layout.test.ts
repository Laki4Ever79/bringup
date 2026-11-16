// The chassis solver under a competition's rules (src/rules/layout.ts): real run 11 (Eurobot brief, 16 Nov 2026) got a
// plain rover from layout_chassis and the agent added the rules' parts by hand (a made-up e-stop, the beacon support
// 164.7 mm off centre, a robot that tipped). The solver now returns them in place, and the layout passes the rules.
import { test } from "node:test"
import assert from "node:assert/strict"
import { defaultCheckCatalog, mechanicsChecksWith } from "../src/mechanics/checks.ts"
import { laidOut } from "../src/mechanics/solve.ts"
import { EUROBOT_BOARD } from "../src/inference/scripts.ts"

test("a plain rover proposed under Eurobot's rules comes back with the beacon, e-stop, start and braking cap, passing the rules", () => {
	const cat = defaultCheckCatalog()!
	const v = JSON.parse(JSON.stringify(EUROBOT_BOARD))
	const plain = { ...v.mechanics }
	delete plain.beacon
	delete plain.safety
	delete plain.sticker
	delete plain.drive.maxAccelMps2
	const s = { revision: 1, versions: {} as never, values: { ...v, mechanics: plain } }
	assert.ok(mechanicsChecksWith(s, cat).some((x) => x.kind === "mech-rules"), "the plain rover fails the rules")
	const l = laidOut(s, plain, cat)
	const m = l.mechanics
	assert.deepEqual(m.beacon?.at, { xMm: 0, yMm: 0 })
	assert.equal(m.beacon?.topMm, 430)
	assert.match(m.safety?.estop?.part ?? "", /^OMRON A22E-M-01/)
	assert.equal(m.safety?.estop?.connector, "JE1")
	assert.equal(m.safety?.start?.connector, "JS1")
	assert.equal(m.drive.maxAccelMps2, 1.5)
	assert.equal(m.sticker?.face, "rear")
	const after = mechanicsChecksWith({ ...s, values: { ...s.values, mechanics: m } }, cat)
	assert.deepEqual(after.filter((x) => x.affects.includes("mechanics")).map((x) => x.message), [])
})
