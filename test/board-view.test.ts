// The board page's data (engineer, 13 Nov 2026: a full-window board view, a card per part with why it's there, and
// the board changing live during a run): placement from the contract at once, the routed board when built.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { boardParts, bringupPads, debugPort } from "../src/codegen/circuit.ts"
import { boardView, changedRefs, previewCircuit } from "../src/dashboard/board-view.ts"
import { circuitIndex } from "../src/dashboard/pcb-view.js"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { fixtureContract } from "./fixture.ts"

const logger = (): ContractSnapshot => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	return s
}

test("the placement preview reads as a board in pcb-view: every part a box on top, the pads and the debug footprint below", () => {
	const s = logger()
	const ix = circuitIndex(previewCircuit(s) as never[])
	assert.equal(ix.board?.w, s.values.outline!.widthMm)
	const refs = new Set(ix.components.map((c) => c.ref))
	for (const p of boardParts(s)) assert.ok(refs.has(p.ref), p.ref)
	const tp = ix.components.find((c) => c.ref === bringupPads(s).placed[0].ref)!
	assert.equal(tp.layer, "bottom")
	assert.ok(ix.pads.some((p) => p.ref === tp.ref && p.net === bringupPads(s).placed[0].net), "a pad names its net")
	assert.equal(ix.pads.filter((p) => p.ref === debugPort(s).placed!.ref).length, 6)
	assert.equal(ix.traces.length, 0)
})

test("what changed between two revisions: a part added, one moved by a narrower board", () => {
	const a = logger()
	const b = logger()
	b.values.outline = { ...b.values.outline!, widthMm: 40 }
	b.values.parts = [...b.values.parts!, { ref: "SW1", role: "button", mpn: "TS-1187A-B-A-B", lcsc: "C318884", footprint: "pushbutton", pins: ["A", "B"] }]
	const c = changedRefs(a, b)
	assert.deepEqual(c.added, ["SW1"])
	assert.ok(c.changed.length > 0, "a narrower board moves parts")
	assert.deepEqual(changedRefs(null, b), { added: [], removed: [], changed: [] })
})

test("a run folder: the newest revision by default, any revision by number, the routed board when that revision was built", async () => {
	const dir = mkdtempSync(join(tmpdir(), "board-view-"))
	try {
		mkdirSync(join(dir, "contracts"))
		const one = { ...logger(), revision: 1 }
		const two = { ...logger(), revision: 2 }
		two.values.outline = { ...two.values.outline!, widthMm: 40 }
		writeFileSync(join(dir, "contracts", "rev-1.json"), JSON.stringify(one))
		writeFileSync(join(dir, "contracts", "rev-2.json"), JSON.stringify(two))
		writeFileSync(join(dir, "brief.md"), "# Brief: pocket climate logger\n")
		mkdirSync(join(dir, "board", "rev-1"), { recursive: true })
		writeFileSync(join(dir, "board", "rev-1", "circuit.json"), "[]")
		const latest = (await boardView(dir, null))!
		assert.equal(latest.revision, 2)
		assert.deepEqual(latest.revisions, [1, 2])
		assert.equal(latest.routed, null, "revision 2 isn't built yet")
		assert.equal(latest.routedRevision, 1)
		assert.equal(latest.widthMm, 40)
		assert.ok(latest.changed.changed.length > 0)
		assert.ok(latest.reasons.some((r) => r.ref === "U2" && r.source.kind === "recorded"))
		const first = (await boardView(dir, 1))!
		assert.equal(first.routed, "board/rev-1/circuit.json")
		assert.equal(first.summary.length > 0, true)
		assert.equal(await boardView(join(dir, "nothing"), null), null)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
