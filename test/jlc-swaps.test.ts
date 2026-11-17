// Cheaper at JLCPCB (src/package/jlc-swaps.ts): a drop-in that shares a feeder already loaded is offered; a part of
// another footprint (an STM32 for the ESP32 module) or one that fails the design's checks is not.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { jlcSwaps, type JlcClass } from "../src/package/jlc-swaps.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"

const ROOT = join(import.meta.dirname, "..")
// Classes as jlcsearch gave them on 16-17 Nov 2026 (offline here): the connectors, module, driver and sensor extended.
const EXTENDED = ["C165948", "C173752", "C131337", "C160404", "C2838502", "C2909890", "C51118", "C50506", "C841192", "C32574", "C160405", "C2869734"]
// The STM32F103 (C8734) is preferred; any part not listed is unknown (never counted as free).
const classOf = (lcsc: string): JlcClass | null => (EXTENDED.includes(lcsc) || lcsc === "C194656" ? { basic: false, preferred: false } : lcsc === "C5446" || lcsc === "C6186" ? { basic: true, preferred: false } : lcsc === "C8734" ? { basic: false, preferred: true } : null)

test("the battery plug becomes the motor plugs' part (one feeder for three), the module and LDO stay, each with its reason", () => {
	const s = { revision: 1, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) }
	const r = jlcSwaps(s as never, classOf, { root: ROOT, feeUsd: 3.07 })
	assert.deepEqual(r.swaps.map((w) => `${w.ref}:${w.to}`), ["J2:B2B-PH-K-S(LF)(SN)"])
	assert.equal(r.swaps[0].savesUsd, 3.07)
	assert.ok(r.refused.some((x) => x.ref === "U1" && /not a drop-in/.test(x.reason)), "an STM32 for the ESP32 module is a redesign")
	assert.ok(r.stays.some((x) => x.ref === "J1"))
	assert.ok(readFileSync(join(ROOT, "src/tools/parts-search.ts"), "utf8").includes("JLCPCB basic and preferred parts first"))
})
