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
	// Its Cyphal/CAN node-ID: a is 1, b is 2 (the link's order).
	assert.deepEqual(l.can, { kbps: 500, terminate: true, node: 1 })
	assert.equal(linksShapeError([l]), null)
	assert.match(String(linksShapeError([{ ...l, can: undefined }])), /L1 is a CAN link: it needs can \{kbps, terminate\}/)
	assert.deepEqual(boardLinks(canSpec({ can: { kbps: 1000 } }), "b")[0].can, { kbps: 1000, terminate: true, node: 2 })
})

test("the spec takes only the bit rates nodes agree on, and messages that fit one Cyphal frame (7 bytes and the tail byte)", () => {
	assert.ok(specErrors(canSpec({ can: { kbps: 300 } })).some((e) => /300 kbit\/s is not a CAN bit rate/.test(e)))
	const big = canSpec({ messages: [{ name: "pose", from: "a", fields: [{ name: "x", type: "f32" }, { name: "y", type: "f32" }, { name: "t", type: "u8" }] }] })
	assert.ok(specErrors(big).some((e) => /message pose is 9 bytes; a Cyphal\/CAN frame carries 7 \(8 less its tail byte\)/.test(e)))
	// 8 bytes fitted a bare CAN frame; with Cyphal's tail byte it doesn't.
	const eight = canSpec({ messages: [{ name: "pose", from: "a", fields: [{ name: "x", type: "f32" }, { name: "y", type: "f32" }] }] })
	assert.ok(specErrors(eight).some((e) => /message pose is 8 bytes/.test(e)))
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

// ---- the board's side: the transceiver, its wiring, the termination ----------------------------------------------
import { CAN_TRANSCEIVER, canSignals, linkBudget, linkChecks, linkFactLines, LINK_CONNECTOR } from "../src/contract/links.ts"
import { circuitFromContract, generatedNets, supportParts } from "../src/codegen/circuit.ts"

// A board that took its CAN link: the connector and the transceiver in its parts, TX to D and RX to R on free GPIOs.
const wired = (spec: SystemSpec, name: string): ContractSnapshot => {
	const s = board(spec, name)
	const [l] = s.values.links!
	s.values.parts = [...s.values.parts!, { ref: l.connector, role: "connector", ...LINK_CONNECTOR }, { ref: "U9", role: "can-transceiver", ...CAN_TRANSCEIVER }]
	const used = new Set(s.values.pins!.map((p) => p.gpio))
	const [g1, g2] = [4, 5, 6, 7, 3, 1, 0].filter((g) => !used.has(g))
	s.values.pins = [...s.values.pins!, { signal: canSignals(l).tx, gpio: g1, partRef: "U9", partPin: "D" }, { signal: canSignals(l).rx, gpio: g2, partRef: "U9", partPin: "R" }]
	return s
}

test("a board on a CAN link needs the transceiver and its TX/RX; the facts say how it is wired", () => {
	const spec = canSpec()
	const bare = board(spec, "a")
	bare.values.parts = [...bare.values.parts!, { ref: bare.values.links![0].connector, role: "connector", ...LINK_CONNECTOR }]
	assert.ok(linkChecks(bare).some((v) => v.kind === "link-connector-missing" && /needs its transceiver: a part role can-transceiver, SN65HVD230DR/.test(v.message)))
	const s = wired(spec, "a")
	assert.deepEqual(linkChecks(s).filter((v) => v.kind !== "link-connector-missing" || !/not on an edge/.test(v.message)), [])
	const half = structuredClone(s)
	half.values.pins = half.values.pins!.filter((p) => p.signal !== "L1_CAN_RX")
	assert.ok(linkChecks(half).some((v) => v.kind === "link-unwired" && /assign L1_CAN_RX to U9.R/.test(v.message)))
	assert.match(linkFactLines(s).join("\n"), /CAN at 500 kbit\/s through a SN65HVD230DR transceiver .* 120 Ω across them on this board/)
	// The budget charges the two signals until they are wired.
	assert.deepEqual(linkBudget(s), [])
})

test("the generator wires the bus side: CANH/CANL to the connector, RS to GND, 100 nF and 120 Ω", () => {
	const s = wired(canSpec(), "a")
	const nets = generatedNets(s)
	const k = s.values.links![0].connector
	// The transceiver, the connector, and the terminating resistor's end.
	const term0 = supportParts(s).find((sp) => sp.spec.value === "120")!
	assert.deepEqual(nets.get("L1_CANH"), ["U9.CANH", `${k}.IO1`, `${term0.ref}.pin1`])
	assert.deepEqual(nets.get("L1_CANL"), ["U9.CANL", `${k}.IO2`, `${term0.ref}.pin2`])
	assert.ok(nets.get("GND")!.includes("U9.RS") && nets.get("GND")!.includes("U9.GND"))
	const jobs = supportParts(s).filter((sp) => sp.near === "U9")
	assert.deepEqual(jobs.map((sp) => sp.spec.value).sort(), ["100nF", "120"])
	const term = jobs.find((sp) => sp.spec.value === "120")!
	assert.deepEqual([term.a, term.b], [{ net: "L1_CANH" }, { net: "L1_CANL" }])
	const src = circuitFromContract(s)
	assert.match(src, /<chip name="U9"[^\n]*footprint="soic8_w4.4mm_p1.27mm"/)
	assert.match(src, /<net name="L1_CANH" \/>/)
	// Not terminated: no 120 Ω.
	const mid = structuredClone(s)
	mid.values.links![0].can!.terminate = false
	assert.ok(!supportParts(mid).some((sp) => sp.spec.value === "120"))
})

test("the report's standards table lists the CAN link and its messages as open: Cyphal/CAN v1.0", async () => {
	const { interfacesOf } = await import("../src/contract/standards.ts")
	const rows = interfacesOf(board(canSpec(), "a"))
	assert.equal(rows.find((r) => r.interface.startsWith("CAN link"))?.openness, "open")
	const m = rows.find((r) => r.interface.startsWith("messages over a CAN link"))!
	assert.equal(m.openness, "open")
	assert.match(m.standard, /^Cyphal\/CAN v1\.0/)
	assert.equal(m.alternative, undefined)
})

// Cyphal/CAN v1.0 (17 Nov 2026): each board's node-ID and each message's subject-ID in link.h, a DSDL file per message
// for yakut or pycyphal, and two messages that would share a subject-ID on one bus refused by the spec.
test("CAN messages are Cyphal: node-ID and subject-ID in link.h, a DSDL file per message, no shared subject-ID on a bus", async () => {
	const { linkHeader, dsdlFiles } = await import("../src/codegen/firmware.ts")
	const { cyphalSubject } = await import("../src/contract/links.ts")
	const a = board(canSpec(), "a")
	const h = linkHeader(a)
	const subject = cyphalSubject(a.values.links![0].messages![0].hash)
	assert.ok(subject >= 0 && subject < 6144)
	assert.match(h, /#define LINK_L1_CAN_NODE 1 /)
	assert.match(h, new RegExp(`#define MSG_SPEED_SUBJECT ${subject} `))
	assert.match(linkHeader(board(canSpec(), "b")), /#define LINK_L1_CAN_NODE 2 /)
	assert.deepEqual(dsdlFiles(a), [{ path: "dsdl/bringup/Speed.1.0.dsdl", text: `# Generated by Bringup: message speed on Cyphal subject-ID ${subject}, fields in the order they travel.\nint16 left\nint16 right\n@sealed\n` }])
	// m32 and m137 (one u8 field each) fold onto one subject-ID, 3990.
	const v = [{ name: "v", type: "u8" as const }]
	const clash = canSpec({ messages: [{ name: "m32", from: "a", fields: v }, { name: "m137", from: "b", fields: v }] })
	assert.ok(specErrors(clash).some((e) => /CAN bus L1: messages m32 and m137 share the Cyphal subject-ID 3990: rename one/.test(e)), specErrors(clash).join("\n"))
})
