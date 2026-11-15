// Rover run cc-rover-5 (15 Nov 2026, Claude subscription): the pack-peak check counted VBUS 300 + VBAT 1400 + 3V3 190 mA
// as electronics (the motors twice, USB as the cell), so no catalog motor fit the 2 A cell and the run ended on it.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { cellFedElectronics, mechanicsChecks } from "../src/mechanics/checks.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

test("the electronics the cell feeds are the regulated rails, not USB's input or the cell's own rail", () => {
	const r = (name: string) => ({ name })
	assert.deepEqual(cellFedElectronics([r("VBUS"), r("VBAT"), r("3V3")]).map((x) => x.name), ["3V3"])
	assert.deepEqual(cellFedElectronics([r("VBAT")]).map((x) => x.name), ["VBAT"], "a cell rail alone still counts")
})

test("run 5's design passes the pack-peak check: both motors at stall plus 0.19 A of electronics", () => {
	const s = JSON.parse(readFileSync(new URL("./fixtures/cc-rover-5-rev26.json", import.meta.url), "utf8")) as ContractSnapshot
	assert.deepEqual(mechanicsChecks(s).filter((v) => v.kind === "mech-current"), [])
})
