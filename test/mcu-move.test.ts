// A robot asking for wheel encoders counts both channels; when its MCU can't carry them on pins free at reset it moves
// up (src/contract/mcu-move.ts). Real run 18/19b (Eurobot): the ESP32-C3-MINI-1 has 8 unreserved GPIOs and the base
// needs 11 with both channels, so its pins went onto strapping pins; the ESP32-S3-MINI-1 has 31 and PCNT.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { gpioBudget, moveUpMcu, unreservedGpios } from "../src/contract/mcu-move.ts"
import { loadCatalog } from "../src/tools/parts-search.ts"
import { mcuProfileOf, profileById } from "../src/mcu/profile.ts"
import { rankMcus } from "../src/mcu/select.ts"
import { mechanicsChecks } from "../src/mechanics/checks.ts"
import { countsPerRev, roverHeader } from "../src/mechanics/firmware.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

const fx = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8")) as ContractSnapshot
const catalog = loadCatalog(fileURLToPath(new URL("..", import.meta.url))) as never
const moved = (s: ContractSnapshot) => {
	const up = moveUpMcu(s.values.parts!, s.values.pins!, s.values.motion, catalog)
	assert.ok(up, "moves up")
	return { up, s: { ...s, values: { ...s.values, parts: up.parts, pins: up.pins } } as ContractSnapshot }
}

test("19b rev 41 (C3, encoders asked): 11 signals with both channels against 8 free pins move U1 up to the ESP32-S3", () => {
	const s = fx("cc-eurobot-19b-rev41.json")
	const c3 = profileById("esp32-c3-mini-1")!
	assert.equal(unreservedGpios(c3).length, 8)
	assert.equal(gpioBudget(s.values.parts!, s.values.pins!, s.values.motion).length, 11)
	const { s: after } = moved(s)
	const s3 = mcuProfileOf(after.values.parts)!
	assert.equal(s3.id, "esp32-s3-mini-1")
	assert.equal(after.values.parts!.find((p) => p.role === "mcu")!.ref, "U1")
	const at = (sig: string) => after.values.pins!.find((p) => p.signal === sig)
	// USB on the S3's own pins; nothing else on a pin the S3 reserves (straps 0/3/45/46, USB, console).
	assert.deepEqual([at("USB_DP")!.gpio, at("USB_DN")!.gpio], [20, 19])
	const free = new Set(unreservedGpios(s3))
	for (const p of after.values.pins!) if (!/^USB_/.test(p.signal)) assert.ok(free.has(p.gpio), `${p.signal} on GPIO${p.gpio}`)
	assert.deepEqual([at("ENC_LB")!.partRef, at("ENC_LB")!.partPin, at("ENC_RB")!.partRef, at("ENC_RB")!.partPin], ["JM1", "ENCB", "JM2", "ENCB"])
	assert.equal(new Set(after.values.pins!.map((p) => p.gpio)).size, after.values.pins!.length, "one signal per pin")
	// Done once: the S3 carries them.
	assert.equal(moveUpMcu(after.values.parts!, after.values.pins!, after.values.motion, catalog), null)
})

test("a robot that doesn't ask for encoders keeps its MCU (rover-9), and so does the mock Eurobot's pins once on the S3", () => {
	const r = fx("cc-rover-9-rev24.json")
	assert.equal(moveUpMcu(r.values.parts!, r.values.pins!, r.values.motion, catalog), null)
	const { s } = moved(fx("mock-eurobot-rev8.json"))
	assert.equal(mcuProfileOf(s.values.parts)!.id, "esp32-s3-mini-1")
})

test("on the S3 both encoder channels are required (mech-wiring); on the C3 channel A alone", () => {
	const { s } = moved(fx("cc-eurobot-19b-rev41.json"))
	const wiring = (x: ContractSnapshot) => mechanicsChecks(x).filter((v) => v.kind === "mech-wiring" && /encoders' outputs/.test(v.message)).map((v) => v.message).join("\n")
	assert.equal(wiring(s), "")
	const noB = { ...s, values: { ...s.values, pins: s.values.pins!.filter((p) => p.signal !== "ENC_LB") } } as ContractSnapshot
	assert.match(wiring(noB), /ENC_LB \(partRef JM1, partPin ENCB\)/)
	assert.equal(wiring(fx("cc-eurobot-19b-rev41.json")), "")
})

test("the firmware counts in quadrature when both channels are wired: every edge, the catalog's cpr", () => {
	const c3 = fx("cc-eurobot-19b-rev41.json")
	const { s } = moved(c3)
	const motor = { gearRatio: 10, encoder: { cpr: 12 } }
	assert.equal(countsPerRev(motor), 60)
	assert.equal(countsPerRev(motor, true), 120)
	const def = (h: string, name: string) => new RegExp(`#define ${name} (\\S+)`).exec(h)?.[1]
	const h3 = roverHeader(s)
	const hc = roverHeader(c3)
	assert.equal(def(h3, "ROVER_ENC_QUADRATURE"), "1")
	assert.equal(def(hc, "ROVER_ENC_QUADRATURE"), undefined)
	assert.equal(parseFloat(def(h3, "ROVER_ENC_COUNTS_PER_REV")!), 2 * parseFloat(def(hc, "ROVER_ENC_COUNTS_PER_REV")!))
	assert.ok(def(h3, "PIN_ENC_LB") && def(h3, "PIN_ENC_RB"))
})

// Both have a simulator since the Xtensa QEMU (19 Nov 2026: the S3's drive runs in qemu-system-xtensa); the C3 still
// ranks above on price, so a design that fits the C3 keeps it.
test("when both fit, the C3 still ranks above the S3 (both simulate; the C3 costs less)", () => {
	const r = rankMcus({ needs: [{ signal: "LED", kind: "gpio" }] })
	const pos = (id: string) => r.findIndex((x) => x.id === id)
	assert.ok(pos("esp32-c3-mini-1") < pos("esp32-s3-mini-1"))
	for (const id of ["esp32-c3-mini-1", "esp32-s3-mini-1"]) assert.ok(r.find((x) => x.id === id)!.why.some((w) => /simulator qemu/.test(w)), id)
})
