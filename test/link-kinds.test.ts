// Links between boards, every kind (docs/system.md, docs/superpowers/specs/2026-11-11-board-links-design.md): one
// table of kinds that the spec, the board's links field and the checks all read, and the pin and peripheral budget.
import { test } from "node:test"
import assert from "node:assert/strict"
import { BUILT_KINDS, LINK_KINDS, type LinkKind } from "../src/contract/link-kinds.ts"
import { linksShapeError } from "../src/contract/links.ts"
import { boardLinks } from "../src/system/derive.ts"
import { specErrors, type SystemSpec } from "../src/system/spec.ts"

const spec = (kind: LinkKind): SystemSpec => ({
	name: "two boards",
	boards: [{ name: "a", brief: "x.md" }, { name: "b", brief: "y.md" }],
	links: [{ id: "L1", kind, a: { board: "a" }, b: { board: "b" }, cable: { lengthMm: 300 }, messages: [{ name: "reading", from: "a", fields: [{ name: "t", type: "i16" }] }] }],
})

test("every kind has one entry; only UART and I2C are built", () => {
	assert.deepEqual(Object.keys(LINK_KINDS), ["uart", "i2c", "spi", "i2s", "espnow", "ble"])
	assert.deepEqual(BUILT_KINDS, ["uart", "i2c"])
	assert.equal(LINK_KINDS.spi.gpios, 4)
	assert.equal(LINK_KINDS.i2s.carries, "stream")
	assert.equal(LINK_KINDS.ble.connector, null)
	assert.equal(LINK_KINDS.espnow.medium, "radio")
})

test("a spec naming an unbuilt kind is a clear error, not a crash", () => {
	for (const kind of ["spi", "i2s", "espnow", "ble"] as const) {
		const s = spec(kind)
		assert.ok(specErrors(s).includes(`link L1: kind ${kind} is planned (docs/system.md), not built yet`), specErrors(s).join("\n"))
		assert.doesNotThrow(() => boardLinks(s, "a"))
	}
})

test("the shape check accepts only kinds the table knows", () => {
	const [l] = boardLinks(spec("uart"), "a")
	assert.equal(linksShapeError([l]), null)
	assert.match(String(linksShapeError([{ ...l, kind: "can" }])), /links must be an array/)
})

// ---- the pin and peripheral budget ----------------------------------------------------------------------------
import { linkBudget, LINK_CONNECTOR } from "../src/contract/links.ts"
import { FREE_GPIOS } from "../src/contract/link-kinds.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { fixtureContract } from "./fixture.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

function logger(links: ReturnType<typeof boardLinks>): ContractSnapshot {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN), links }
	for (const l of links) s.values.parts = [...s.values.parts!, { ref: l.connector, role: "connector", ...LINK_CONNECTOR }]
	return s
}
const twoUarts = (): SystemSpec => ({
	name: "three boards",
	boards: [{ name: "a", brief: "x.md" }, { name: "b", brief: "y.md" }, { name: "c", brief: "z.md" }],
	links: [
		{ id: "L1", kind: "uart", a: { board: "a" }, b: { board: "b" }, cable: { lengthMm: 300 } },
		{ id: "L2", kind: "uart", a: { board: "a" }, b: { board: "c" }, cable: { lengthMm: 300 } },
	],
})
const fill = (s: ContractSnapshot, leave: number) => {
	const used = new Set((s.values.pins ?? []).map((p) => p.gpio))
	const free = FREE_GPIOS.filter((g) => !used.has(g))
	s.values.pins = [...s.values.pins!, ...free.slice(0, free.length - leave).map((gpio, i) => ({ signal: `X${i}`, gpio, partRef: "U1", partPin: `GPIO${gpio}` }))]
	return s
}

test("two UART links on one board are over its peripheral budget, in the spec and on the board", () => {
	assert.ok(specErrors(twoUarts()).some((e) => /^board a: L1, L2 all need its uart \(the ESP32-C3 has 1 free\); make the others I2C/.test(e)), specErrors(twoUarts()).join("\n"))
	const v = linkBudget(logger(boardLinks(twoUarts(), "a")))
	assert.deepEqual(v.filter((x) => x.affects[0] === "integrator").map((x) => x.kind), ["link-budget"])
})

test("a UART link with only one free GPIO left names the pins it needs", () => {
	const s = fill(logger(boardLinks(spec("uart"), "a")), 1)
	const v = linkBudget(s)
	assert.equal(v.length, 1)
	assert.deepEqual([v[0].kind, v[0].affects[0]], ["link-budget", "architect"])
	assert.match(v[0].message, /L1 need 2 more GPIOs.*1 are free/)
})

test("an I2C link on a board that already has its bus needs no new pins", () => {
	const i2c: SystemSpec = { ...spec("i2c"), links: [{ ...spec("i2c").links[0], messages: [], i2c: { controller: "a", targets: { b: 0x42 }, pullupsOn: "a" } }] }
	const s = fill(logger(boardLinks(i2c, "a")), 0)
	assert.deepEqual(linkBudget(s), [])
})

test("a single board without links gets no budget finding", () => {
	assert.deepEqual(linkBudget(fixtureContract()), [])
})
