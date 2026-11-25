// The arm's 24 V brick input (lead decision, 25 Nov 2026): XunPu DC-091-A250, rated 24 V 8 A by its maker's drawing,
// pads from JLCPCB's own footprint. A 24 V brick near 3.5 A asks 4.4 A of it with CONNECTOR_HEADROOM; 12 V would ask 8.75 A.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dc091Footprint, DC091_FOOTPRINT, knowsFootprintSize } from "../src/codegen/circuit.ts"
import { CONNECTOR_HEADROOM } from "../src/mechanics/checks.ts"

const parts = JSON.parse(readFileSync(new URL("../catalog/parts.json", import.meta.url), "utf8")) as { mpn: string; lcsc: string | null; footprint?: string; pins: string[]; ratedA?: number; ratedV?: number; source?: Record<string, { url: string; where: string }>; notes?: string }[]

test("the 24 V input jack: sourced 8 A / 24 V, centre pin VIN, sleeve on four legs, and the SY8368A's 4 V margin stated", () => {
	const j = parts.find((p) => p.mpn === "DC-091-A250")!
	assert.equal(j.lcsc, "C720588")
	assert.equal(j.footprint, DC091_FOOTPRINT)
	assert.deepEqual([j.ratedA, j.ratedV], [8, 24])
	for (const k of ["ratedA", "ratedV", "pins", "footprint", "lcsc"]) assert.ok(j.source?.[k]?.url, k)
	assert.deepEqual(j.pins, ["VIN", "SW", "GND", "GND_2", "GND_3", "GND_4"])
	assert.match(j.notes ?? "", /28 V input maximum leaves 4 V of margin/)
	// A 24 V brick at about 3.5 A fits with the headroom; 12 V's 7 A would not fit a 5 A jack.
	assert.ok(3.5 * CONNECTOR_HEADROOM <= j.ratedA!)
	assert.ok(knowsFootprintSize(DC091_FOOTPRINT))
})

test("its footprint: six plated pads (pin1 the 1.5 mm centre pin, pin2 the switch, pins 3-6 the shield legs) and the locating hole", () => {
	const fp = dc091Footprint()
	assert.equal(fp.match(/<platedhole /g)?.length, 6)
	for (let k = 1; k <= 6; k++) assert.ok(fp.includes(`portHints={["pin${k}"]}`), `pin${k}`)
	assert.match(fp, /portHints=\{\["pin1"\]\} pcbX="4.825mm" pcbY="0mm" holeDiameter="1.5mm"/)
	assert.equal(fp.match(/<hole /g)?.length, 1)
})
