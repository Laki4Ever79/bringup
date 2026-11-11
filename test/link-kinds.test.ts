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
