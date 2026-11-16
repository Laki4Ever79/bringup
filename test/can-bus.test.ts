// A CAN bus of more than two boards (link.can.bus): daisy-chained segments, 120 Ω only at the two ends, one controller
// and one transceiver per board, and the spec's refusals.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { canChain, specErrors, type SystemSpec, type SystemLink } from "../src/system/spec.ts"
import { boardLinks } from "../src/system/derive.ts"
import { canSignals } from "../src/contract/links.ts"

const spec = (): SystemSpec => JSON.parse(readFileSync(new URL("../briefs/systems/can-three.json", import.meta.url), "utf8"))
const seg = (id: string, a: string, b: string, extra: Partial<SystemLink> = {}): SystemLink => ({ id, kind: "can", a: { board: a }, b: { board: b }, can: { kbps: 500, bus: "B1" }, cable: { lengthMm: 500 }, ...extra })

test("the three-board spec is one chain, valid, and terminated only at its two ends", () => {
	const s = spec()
	assert.deepEqual(specErrors(s), [])
	assert.deepEqual(canChain(s.links), ["sensor-a", "hub", "sensor-b"])
	assert.deepEqual(boardLinks(s, "sensor-a").map((l) => l.can?.terminate), [true])
	assert.deepEqual(boardLinks(s, "sensor-b").map((l) => l.can?.terminate), [true])
	assert.deepEqual(boardLinks(s, "hub").map((l) => l.can?.terminate), [false, false])
	// The hub's two segments share one controller and one transceiver: the same signal names.
	const [l1, l2] = boardLinks(s, "hub")
	assert.deepEqual(canSignals(l1), canSignals(l2))
	assert.equal(canSignals(l1).tx, "B1_CAN_TX")
})

test("a link without a bus is still a two-board bus terminated at both ends", () => {
	const s: SystemSpec = { name: "pair", boards: [{ name: "a", brief: "x" }, { name: "b", brief: "x" }], links: [{ ...seg("L1", "a", "b"), can: { kbps: 500 } }] }
	assert.deepEqual(specErrors(s), [])
	assert.equal(canSignals(boardLinks(s, "a")[0]).tx, "L1_CAN_TX")
	assert.equal(boardLinks(s, "a")[0].can?.terminate, true)
})

test("refused: a star, mixed bit rates, a bus too long, one message sent by two nodes", () => {
	const boards = ["a", "b", "c", "d"].map((name) => ({ name, brief: "x" }))
	const star: SystemSpec = { name: "star", boards, links: [seg("L1", "a", "b"), seg("L2", "a", "c"), seg("L3", "a", "d")] }
	assert.ok(specErrors(star).some((e) => /chain the boards one after another/.test(e)))
	const rates: SystemSpec = { name: "rates", boards, links: [seg("L1", "a", "b"), seg("L2", "b", "c", { can: { kbps: 250, bus: "B1" } })] }
	assert.ok(specErrors(rates).some((e) => /share one bit rate/.test(e)))
	const long: SystemSpec = { name: "long", boards, links: [seg("L1", "a", "b", { cable: { lengthMm: 30000 } }), seg("L2", "b", "c", { can: { kbps: 1000, bus: "B1" }, cable: { lengthMm: 30000 } })] }
	assert.ok(specErrors({ ...long, links: long.links.map((l) => ({ ...l, can: { kbps: 1000, bus: "B1" } })) }).some((e) => /add up to 60 m, over the 40 m/.test(e)))
	const msg = { name: "reading", fields: [{ name: "tempCx100", type: "i16" as const }] }
	const twice: SystemSpec = { name: "twice", boards, links: [seg("L1", "a", "b", { messages: [{ ...msg, from: "a" }] }), seg("L2", "b", "c", { messages: [{ ...msg, from: "c" }] })] }
	assert.ok(specErrors(twice).some((e) => /a and c all send reading: on one bus each frame identifier has one sender/.test(e)))
})

test("a middle board's two segments use the chip's one CAN controller once", () => {
	assert.ok(!specErrors(spec()).some((e) => /all need its can/.test(e)))
})
