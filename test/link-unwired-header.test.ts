// A link whose pins aren't assigned yet still gets a link.h that compiles (bringup-lead, 14 Nov 2026: the rover's
// firmware at revision 8 failed, "include/link.h: PIN_L1_TX not declared": the link had its connector, and the architect
// assigns its TX and RX a turn later). Until then the link's code is left out and says why; link-unwired tells the
// architect.
import { test } from "node:test"
import assert from "node:assert/strict"
import { linkHeader } from "../src/codegen/firmware.ts"
import { boardLinks } from "../src/system/derive.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import type { SystemSpec } from "../src/system/spec.ts"
import { fixtureContract } from "./fixture.ts"

const spec: SystemSpec = {
	name: "two boards",
	boards: [{ name: "a", brief: "x.md" }, { name: "b", brief: "y.md" }],
	links: [{ id: "L1", kind: "uart", a: { board: "a" }, b: { board: "b" }, cable: { lengthMm: 300 }, messages: [{ name: "reading", from: "a", fields: [{ name: "t", type: "i16" }] }] }],
}
const board = (wired: boolean) => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN), links: boardLinks(spec, "a") }
	if (wired) s.values.pins = [...s.values.pins!, { signal: "L1_TX", gpio: 6, partRef: "JL1", partPin: "IO1" }, { signal: "L1_RX", gpio: 7, partRef: "JL1", partPin: "IO2" }]
	return s
}

test("a UART link without its TX and RX pins yet: link.h names no PIN_L1_ macro and says the link waits for its pins", () => {
	const h = linkHeader(board(false))
	assert.doesNotMatch(h, /PIN_L1_/)
	assert.doesNotMatch(h, /linkFrameWrite\(Serial1/)
	assert.match(h, /L1.*no TX and RX pins yet/)
	assert.match(h, /static void linkBegin\(\)/)
	assert.match(h, /static void linkSendReading\(/)
})

test("once wired, the UART code is there as before", () => {
	const h = linkHeader(board(true))
	assert.match(h, /Serial1\.begin\(LINK_L1_BAUD, SERIAL_8N1, PIN_L1_RX, PIN_L1_TX\)/)
	assert.match(h, /linkFrameWrite\(Serial1, MSG_READING_HASH/)
})
