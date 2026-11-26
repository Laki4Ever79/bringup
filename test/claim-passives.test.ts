import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { supportParts } from "../src/codegen/circuit.ts"
import { unconnectedParts } from "../src/contract/consistency.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

// cad's arm run (26 Nov 2026): an agent listed C4 CL05A105KA5NQNC, the generator's own 1 uF bypass, under another LCSC
// number; the generator matched by LCSC number only, added its own and left C4 wired to nothing (part-unconnected).
const arm = () => JSON.parse(readFileSync(new URL("./fixtures/arm-board-test.json", import.meta.url), "utf8")) as ContractSnapshot
const cap = (ref: string, over: Record<string, unknown>) => ({ ref, role: "capacitor", mpn: "CL05A105KA5NQNC", lcsc: "C15849", footprint: "0402", pins: ["pin1", "pin2"], ...over })

test("an agent's passive that duplicates a generated one (same part number, another LCSC number) stands in for it, wired", () => {
	const s = arm()
	const before = supportParts(s).filter((x) => x.spec.mpn === "CL05A105KA5NQNC")
	assert.ok(before.length >= 1)
	s.values.parts = [...s.values.parts!, cap("C99", {}) as never]
	const sp = supportParts(s)
	const mine = sp.find((x) => x.ref === "C99")!
	assert.equal(mine.added, false)
	assert.equal(sp.filter((x) => x.spec.mpn === "CL05A105KA5NQNC").length, before.length, "not one more")
	assert.deepEqual(unconnectedParts(s).filter((v) => v.message.startsWith("C99")), [])
})

test("one with nets of its own is the agents' wiring, not a duplicate; one of another part is still reported unconnected", () => {
	const s = arm()
	s.values.parts = [...s.values.parts!, cap("C98", { nets: { pin1: "3V3", pin2: "GND" } }) as never, cap("C97", { mpn: "GRM155R61A105KE15D", lcsc: "C77014" }) as never]
	const sp = supportParts(s)
	assert.ok(!sp.some((x) => x.ref === "C98" || x.ref === "C97"))
	assert.ok(unconnectedParts(s).some((v) => v.message.startsWith("C97")))
})
