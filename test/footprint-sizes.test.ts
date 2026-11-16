// Every catalog part's footprint has a measured size in the space model (src/codegen/circuit.ts FOOTPRINT_SIZE, or a
// chip profile's package). An unknown one silently took the 3 × 3 mm default: the Eurobot base's 6-pin encoder plugs
// (9.8 mm courtyards) let the space model compact the board until tscircuit's courtyards overlapped (16 Nov 2026).
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { knowsFootprintSize } from "../src/codegen/circuit.ts"

test("every catalog footprint has a size in the space model", () => {
	const parts = JSON.parse(readFileSync(new URL("../catalog/parts.json", import.meta.url), "utf8")) as { mpn: string; footprint?: string }[]
	const unknown = parts.filter((p) => p.footprint && !knowsFootprintSize(p.footprint)).map((p) => `${p.mpn} (${p.footprint})`)
	assert.deepEqual(unknown, [])
})

// The Eurobot base, 16 Nov: the scripted status LED took GPIO18 (the solver keeps ADC pins for ADC, and USB's pins are
// only a soft reservation), which made the generator leave the USB-C's D+/D- unwired. A board with a USB-C port and an
// MCU with native USB has those two pins taken.
test("a board with a USB-C port reports its MCU's native USB pins as taken", async () => {
	const { nativeUsbIndexes } = await import("../src/codegen/circuit.ts")
	const { ROVER_BOARD } = await import("../src/inference/scripts.ts")
	const v = JSON.parse(JSON.stringify(ROVER_BOARD))
	assert.deepEqual(nativeUsbIndexes({ revision: 1, versions: {} as never, values: v }).sort(), [18, 19])
	v.parts = v.parts.filter((p: { role: string }) => p.role !== "usb-c")
	v.connectors = v.connectors.filter((c: { kind: string }) => c.kind !== "usb-c")
	assert.deepEqual(nativeUsbIndexes({ revision: 1, versions: {} as never, values: v }), [])
})
