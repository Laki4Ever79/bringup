// CAN links between boards (backlog, the user 15 Nov 2026: "allow for user insisting on using CAN communication for
// robot if they want"): the spec, each board's side, and the checks between boards.
import assert from "node:assert/strict"
import { test } from "node:test"
import { linksShapeError } from "../src/contract/links.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { systemChecks } from "../src/system/checks.ts"
import { boardLinks } from "../src/system/derive.ts"
import { CAN_BUS_MAX_M, specErrors, type SystemSpec } from "../src/system/spec.ts"
import { fixtureContract } from "./fixture.ts"

const canSpec = (over: Partial<SystemSpec["links"][number]> = {}): SystemSpec => ({
	name: "two boards on CAN",
	boards: [{ name: "a", brief: "x.md" }, { name: "b", brief: "y.md" }],
	links: [{ id: "L1", kind: "can", a: { board: "a" }, b: { board: "b" }, cable: { lengthMm: 500 }, messages: [{ name: "speed", from: "a", fields: [{ name: "left", type: "i16" }, { name: "right", type: "i16" }] }], ...over }],
})
const board = (spec: SystemSpec, name: string): ContractSnapshot => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN), links: boardLinks(spec, name) }
	return s
}

test("a CAN link: both boards are the bus's ends, at the spec's bit rate (500 kbit/s by default)", () => {
	assert.deepEqual(specErrors(canSpec()), [])
	const [l] = boardLinks(canSpec(), "a")
	assert.deepEqual(l.can, { kbps: 500, terminate: true })
	assert.equal(linksShapeError([l]), null)
	assert.match(String(linksShapeError([{ ...l, can: undefined }])), /L1 is a CAN link: it needs can \{kbps, terminate\}/)
	assert.deepEqual(boardLinks(canSpec({ can: { kbps: 1000 } }), "b")[0].can, { kbps: 1000, terminate: true })
})

test("the spec takes only the bit rates nodes agree on, and messages that fit one 8-byte frame", () => {
	assert.ok(specErrors(canSpec({ can: { kbps: 300 } })).some((e) => /300 kbit\/s is not a CAN bit rate/.test(e)))
	const big = canSpec({ messages: [{ name: "pose", from: "a", fields: [{ name: "x", type: "f32" }, { name: "y", type: "f32" }, { name: "t", type: "u8" }] }] })
	assert.ok(specErrors(big).some((e) => /message pose is 9 bytes; a CAN frame carries 8/.test(e)))
	assert.equal(CAN_BUS_MAX_M[1000], 40)
})

test("between boards: one bit rate, 120 Ω at both ends, a controller on each chip, a cable the bit rate reaches", () => {
	const spec = canSpec()
	const ok = { a: board(spec, "a"), b: board(spec, "b") }
	assert.deepEqual(systemChecks(spec, ok).filter((f) => f.kind.startsWith("can-")), [])
	// A board whose side differs from the spec (another bit rate, no termination) hasn't taken the link: pending, and the
	// system sends it the spec's side again.
	const rate = structuredClone(ok)
	rate.b.values.links![0].can!.kbps = 250
	assert.ok(systemChecks(spec, rate).some((f) => f.kind === "link-pending"))
	const loose = structuredClone(ok)
	loose.b.values.links![0].can!.terminate = false
	assert.ok(systemChecks(spec, loose).some((f) => f.kind === "link-pending"))
	// A long cable at 1 Mbit/s: past ISO 11898's 40 m.
	const long = canSpec({ can: { kbps: 1000 }, cable: { lengthMm: 45_000 } })
	const f = systemChecks(long, { a: board(long, "a"), b: board(long, "b") }).find((x) => x.kind === "can-bus-length")
	assert.ok(f && /at 1000 kbit\/s a CAN bus reaches about 40 m \(ISO 11898\); this cable is 45 m/.test(f.message), f?.message)
	assert.equal(f!.estimate, undefined)
	const slow = canSpec({ can: { kbps: 125 }, cable: { lengthMm: 600_000 } })
	assert.equal(systemChecks(slow, { a: board(slow, "a"), b: board(slow, "b") }).find((x) => x.kind === "can-bus-length")?.estimate, true)
})

test("a chip without a CAN controller is told so", () => {
	const spec = canSpec()
	const a = board(spec, "a")
	a.values.parts = a.values.parts!.map((p) => (p.role === "mcu" ? { ...p, mpn: "RP2040" } : p))
	const f = systemChecks(spec, { a, b: board(spec, "b") }).find((x) => x.kind === "can-controller")
	assert.ok(f && /a's RP2040 has no CAN controller/.test(f.message), JSON.stringify(systemChecks(spec, { a, b: board(spec, "b") })))
})
