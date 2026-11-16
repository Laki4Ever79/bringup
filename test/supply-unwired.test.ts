// Run cc-eurobot-16 (16 Nov 2026): 13 boards were built with no V3V3 net (the contract had no rails yet), U1.3V3 on
// nothing, and the net check, comparing with the same generator, saw nothing missing. Supply pins are now checked
// against the board that was built.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { checkConsistency } from "../src/contract/consistency.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

const fx = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"))

test("run 16's rev-22 board: the MCU's 3V3 and the plugs' VCC on no net are named", () => {
	const s = fx("cc-eurobot-16-rev22.json") as ContractSnapshot
	const b = fx("cc-eurobot-16-rev22-board.json")
	const board = { revision: 22, dir: "", pcbPath: "", stepPath: null, renderPath: null, widthMm: 0, heightMm: 0, ...b }
	const v = checkConsistency(s, { board }).filter((x) => x.kind === "supply-unwired")
	assert.equal(v.length, 1)
	assert.match(v[0].message, /U1\.3V3/)
	assert.match(v[0].message, /JT1\.VCC/)
	assert.deepEqual(v[0].affects, ["architect"])
})
