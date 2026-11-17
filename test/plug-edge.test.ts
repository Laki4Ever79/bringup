// Run cc-eurobot-17 (16 Nov 2026) never wrote the connectors field: the USB-C was placed inside the board, where no cable
// reaches it, and nothing said so. A JST plug inside is fine (run 8's battery plug, reviewed and passed).
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { plugsWithoutEdge } from "../src/contract/consistency.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

test("a USB-C on no edge is named for the architect; JST plugs inside the board are not", () => {
	const s = JSON.parse(readFileSync(new URL("./fixtures/cc-eurobot-17-rev41.json", import.meta.url), "utf8")) as ContractSnapshot
	const v = plugsWithoutEdge(s)
	assert.equal(v.length, 1)
	assert.match(v[0].message, /^J1 is a USB-C plug/)
	assert.deepEqual(v[0].affects, ["architect"])
	const placed = { ...s, values: { ...s.values, connectors: [{ ref: "J1", kind: "usb-c" as const, edge: "bottom" as const, offsetMm: 40, widthMm: 9, heightMm: 3.2 }] } }
	assert.deepEqual(plugsWithoutEdge(placed), [])
})
