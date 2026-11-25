// A 1S robot's 3V3 rail with its drive motors stalled (src/contract/consistency.ts stallSagChecks): the cell sags
// through its internal resistance (catalog internalOhm) and the rail must stay at the MCU's minimum (supplyMinV).
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stallSagChecks } from "../src/contract/consistency.ts"
import { EUROBOT_BOARD, ROVER_BOARD } from "../src/inference/scripts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

const snap = (b: unknown) => ({ revision: 1, versions: {} as never, values: JSON.parse(JSON.stringify(b)) }) as ContractSnapshot

test("every catalog pack states its internal resistance, with a source that says whether it is an estimate", () => {
	const cat = JSON.parse(readFileSync(new URL("../catalog/mechanics.json", import.meta.url), "utf8")) as { batteries: { mpn: string; internalOhm?: number; internalOhmEstimate?: boolean; source?: Record<string, { where: string }> }[] }
	for (const b of cat.batteries) {
		assert.ok(typeof b.internalOhm === "number" && b.internalOhm > 0 && b.internalOhm < 1, b.mpn)
		assert.ok(b.source?.internalOhm?.where, `${b.mpn}: no source`)
		if (b.internalOhmEstimate) assert.match(b.source!.internalOhm.where, /^ESTIMATE/, b.mpn)
	}
})

test("the scripted rover holds its rail with both motors stalled; a 2S robot is not judged here", () => {
	assert.deepEqual(stallSagChecks(snap(ROVER_BOARD)), [])
	assert.deepEqual(stallSagChecks(snap(EUROBOT_BOARD)), [])
})

test("high-power motors on a 1200 mAh cell under a 400 mA 3V3 load brown the MCU out at stall; the rover's own motors don't", () => {
	const s = snap(ROVER_BOARD)
	s.values.mechanics!.drive.motor = "POLOLU-998 50:1 HP 6V"
	s.values.mechanics!.battery.pack = "ADAFRUIT-258 LP-503562 1200 mAh"
	s.values.rails!.find((r) => r.name === "3V3")!.loadMa = 400
	const v = stallSagChecks(s)
	assert.deepEqual(v.map((x) => x.kind), ["rail-stall-sag"])
	assert.match(v[0].message, /sags from 3\.7 V to 3\.2\d V through its 210 mOhm internal resistance \(an estimate/)
	assert.match(v[0].message, /2\.9\d V .*under the ESP32-C3-MINI-1's 3 V minimum/)
	// The rover's own motors (0.67 A stall) on the same cell and load hold it.
	s.values.mechanics!.drive.motor = "POLOLU-2367 100:1 MP 6V"
	assert.deepEqual(stallSagChecks(s), [])
})
