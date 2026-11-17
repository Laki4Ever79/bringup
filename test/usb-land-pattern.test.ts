// Real run 17 (Eurobot, 16 Nov 2026): its rev-41 contract had no connectors field, so the USB-C receptacle's vendor land
// pattern (GND pads 0.17 mm from its own locating holes) wasn't exempted and every build counted 2 DRC errors.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { usbRefsOf } from "../src/tools/board.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

test("the USB-C land pattern exemption follows the part, not the connectors list", () => {
	const s = JSON.parse(readFileSync(new URL("./fixtures/cc-eurobot17-rev41.json", import.meta.url), "utf8")) as ContractSnapshot
	assert.equal(s.values.connectors, undefined)
	assert.deepEqual(usbRefsOf(s), ["J1"])
	// A design that lists it as a connector too names it once.
	assert.deepEqual(usbRefsOf({ ...s, values: { ...s.values, connectors: [{ ref: "J1", kind: "usb-c", edge: "left", offsetMm: 10, widthMm: 9, heightMm: 3.2 }] } } as ContractSnapshot), ["J1"])
})
