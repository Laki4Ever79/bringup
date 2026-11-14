import { test } from "node:test"
import assert from "node:assert/strict"
import { boardFacts, cableFacts, systemFacts } from "../src/system/facts.ts"
import { fixtureContract } from "./fixture.ts"
import type { SystemLink } from "../src/system/spec.ts"
import type { SystemAssembly } from "../src/system/assembly.ts"

const link = (over: Partial<SystemLink> = {}): SystemLink => ({ id: "L1", kind: "uart", a: { board: "main" }, b: { board: "climate" }, cable: { lengthMm: 300 }, messages: [{ name: "reading", from: "climate", fields: [] }, { name: "ack", from: "main", fields: [] }], ...over })

test("every board fact is a non-empty string (chip may be null), links are strings", () => {
	const f = boardFacts(fixtureContract(), "main", { body: "separate", boards: [] }, [link()])
	for (const k of ["size", "power", "mount", "debug"] as const) assert.ok(f[k].length > 0 && !f[k].includes("undefined"), k)
	assert.equal(f.size, "50 × 30 mm")
	assert.ok(f.chip === null || f.chip.length > 0)
	assert.deepEqual(f.links, ["L1 UART to climate"])
	assert.equal(f.mount, "in its case")
	assert.match(f.power, /3\.3 V/)
	assert.match(f.debug, /USB-C/)
})

test("an estimated outline says so; no contract at all shows dashes", () => {
	const asm: SystemAssembly = { body: "chassis", boards: [{ name: "climate", xMm: 0, yMm: 0, rotDeg: 0, outline: { widthMm: 40, heightMm: 30 }, outlineSource: "estimate" }] }
	const f = boardFacts(null, "climate", asm, [])
	assert.equal(f.size, "≈ 40 × 30 mm (estimate)")
	assert.equal(f.mount, "on the chassis")
	assert.equal(f.chip, null)
	assert.equal(f.debug, "—")
	assert.equal(boardFacts(null, "x", undefined, []).size, "—")
	assert.equal(boardFacts(null, "x", { body: "enclosure", boards: [] }, []).mount, "in the shared enclosure")
})

test("a board fed by a link's power says powered by L1; test pads off says no test pads", () => {
	const c = fixtureContract()
	c.values.requirements = { ...c.values.requirements!, testPads: false }
	const f = boardFacts(c, "climate", undefined, [link({ power: { from: "main" } })])
	assert.match(f.power, /powered by L1/)
	assert.match(f.debug, /^no test pads/)
	assert.doesNotMatch(boardFacts(c, "main", undefined, [link({ power: { from: "main" } })]).power, /powered by/)
})

test("cable facts for a UART link of 300 mm with two messages", () => {
	const c = cableFacts(link())
	assert.deepEqual(c, { kind: "UART", length: "300 mm", messages: ["reading from climate", "ack from main"], power: "each board has its own supply" })
	assert.equal(cableFacts(link({ power: { from: "main" } })).power, "main powers climate")
	const s = systemFacts({ main: fixtureContract() }, undefined, [link()])
	assert.deepEqual(Object.keys(s.cables), ["L1"])
	assert.deepEqual(Object.keys(s.boards), ["main"])
})
