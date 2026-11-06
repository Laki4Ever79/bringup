import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runDesign } from "../src/run.ts"
import { checkConsistency } from "../src/contract/consistency.ts"
import { DesignContract } from "../src/contract/contract.ts"
import { connectivityShapeError, partitionLayout, radioPeakMa } from "../src/contract/connectivity.ts"
import { estimatePower, wifiUploadMa } from "../src/contract/power.ts"
import { firmwareBudget, modelChecks } from "../src/contract/model.ts"
import { connectivityHeader } from "../src/codegen/firmware.ts"
import { connectivityFromRequest, LOGGER_DESIGN, WAKE_WORD_MODEL, MIC_PART, MIC_PINS } from "../src/inference/scripts.ts"
import type { Connectivity } from "../src/contract/types.ts"
import { fixtureContract } from "./fixture.ts"
import { tempDir } from "./helpers.ts"

const logger = (connectivity?: Connectivity) => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN), ...(connectivity ? { connectivity } : {}) }
	return s
}
const WIFI: Connectivity = { radio: "wifi", report: ["mqtt"], uploadPeriodS: 3600, updates: "none" }
const kinds = (s: ReturnType<typeof logger>) => checkConsistency(s, {}, "500 mAh").map((v) => v.kind)

test("the contract takes a consistent connectivity field only", () => {
	assert.equal(connectivityShapeError({ radio: "ble", report: ["gatt", "bthome"], updates: "none" }), null)
	assert.equal(connectivityShapeError(WIFI), null)
	assert.equal(connectivityShapeError({ ...WIFI, updates: "ota" }), null)
	for (const bad of [
		{ radio: "ble", report: ["mqtt"], updates: "none" },
		{ radio: "wifi", report: ["bthome"], uploadPeriodS: 3600, updates: "none" },
		{ radio: "wifi", report: ["mqtt"], updates: "none" },
		{ radio: "wifi", report: ["mqtt"], uploadPeriodS: 10, updates: "none" },
		{ radio: "ble", report: ["gatt"], updates: "ota" },
		{ radio: "ble", report: [], updates: "none" },
		{ radio: "zigbee", report: ["gatt"], updates: "none" },
	])
		assert.ok(connectivityShapeError(bad), JSON.stringify(bad))
	assert.ok(new DesignContract().validate({ field: "connectivity", value: { radio: "ble", report: ["mqtt"], updates: "none" } as never, by: "connectivity" }))
})

test("the rail must cover the radio's transmit peak: 170 mA on Bluetooth LE, 350 mA on Wi-Fi (module datasheet v2.2)", () => {
	assert.equal(radioPeakMa(logger())!.ma, 170)
	assert.equal(radioPeakMa(logger(WIFI))!.ma, 350)
	assert.ok(!kinds(logger()).includes("rail-underrated"), "the logger's 200 mA rail covers Bluetooth")
	const v = checkConsistency(logger(WIFI), {}).find((x) => x.kind === "rail-underrated")!
	assert.match(v.message, /below 350 mA with U1 ESP32-C3-MINI-1 transmitting Wi-Fi \(ESP32-C3-MINI-1 & MINI-1U datasheet v2\.2/)
})

test("a regulator rated below the module's 0.5 A supply requirement is flagged whatever the radio", () => {
	const s = logger()
	s.values.parts = s.values.parts!.map((p) => (p.role === "ldo" ? { ...p, mpn: "XC6206P332MR-G", lcsc: "C5446", footprint: "sot23", pins: ["GND", "VOUT", "VIN"] } : p))
	const v = checkConsistency(s, {}).find((x) => x.kind === "supply-underrated")!
	assert.deepEqual(v.affects, ["parts"])
	assert.match(v.message, /rated 200 mA .* needs a supply that can deliver 500 mA/)
	assert.ok(!kinds(logger()).includes("supply-underrated"), "the AP2112K is rated 600 mA")
})

test("Wi-Fi uploads cost the battery: hourly is short of the logger's 180 days, every 8 hours is not", () => {
	assert.equal(wifiUploadMa(logger()), null)
	assert.equal(wifiUploadMa(logger(WIFI))!.averageMa, 0.1)
	assert.ok(kinds(logger()).every((k) => k !== "battery-short"))
	const short = checkConsistency(logger(WIFI), {}, "500 mAh").find((v) => v.kind === "battery-short")!
	assert.deepEqual(short.affects, ["architect", "connectivity"])
	assert.match(short.message, /with Wi-Fi uploads adding 0\.1 mA/)
	const eight = logger({ ...WIFI, uploadPeriodS: 8 * 3600 })
	assert.ok(!kinds(eight).includes("battery-short"), `${estimatePower(eight, "500 mAh").days} days`)
})

test("the update choice picks the partition table, and the flash a model gets follows", () => {
	assert.deepEqual([partitionLayout(logger()).table, partitionLayout(logger()).appBytes], ["default.csv", 0x140000])
	assert.deepEqual([partitionLayout(logger(WIFI)).table, partitionLayout(logger(WIFI)).appBytes], ["no_ota.csv", 0x200000])
	assert.equal(partitionLayout(logger({ ...WIFI, updates: "ota" })).table, "default.csv")
	const ota = firmwareBudget(logger({ ...WIFI, updates: "ota" }))
	assert.equal(ota.appFlashBytes - ota.firmwareFlashBytes, 1_310_720 - 1_188_472)
	// A model with 200 KB of weights fits Wi-Fi without updates, not with: the check says the update slot is the cost.
	const big = logger({ ...WIFI, updates: "ota" })
	big.values.parts = [...big.values.parts!, MIC_PART]
	big.values.pins = [...big.values.pins!, ...MIC_PINS]
	big.values.model = { ...WAKE_WORD_MODEL, weightsKb: 200 }
	const v = modelChecks(big).find((x) => x.kind === "model-flash")!
	assert.deepEqual(v.affects, ["ml", "connectivity"])
	assert.match(v.message, /with no field updates .* one bigger slot/)
	big.values.connectivity = WIFI
	assert.ok(!modelChecks(big).some((x) => x.kind === "model-flash"))
})

test("connectivity.h selects the firmware's radio code; without a field it is Bluetooth LE with GATT, as before", () => {
	assert.match(connectivityHeader(logger()), /#define RADIO_BLE 1\n#define REPORT_GATT 1\n$/)
	const h = connectivityHeader(logger({ ...WIFI, updates: "ota" }))
	assert.match(h, /#define RADIO_WIFI 1/)
	assert.match(h, /#define REPORT_MQTT 1/)
	assert.match(h, /#define UPLOAD_EVERY 12 /)
	assert.match(h, /#define UPDATES_OTA 1/)
})

test("the scripted connectivity engineer reads Home Assistant as BTHome, Wi-Fi as MQTT, updates as Wi-Fi with OTA", () => {
	assert.deepEqual(connectivityFromRequest("show the readings in Home Assistant", undefined), { radio: "ble", report: ["gatt", "bthome"], updates: "none" })
	assert.deepEqual(connectivityFromRequest("send readings over Wi-Fi every 30 minutes", undefined), { radio: "wifi", report: ["mqtt"], uploadPeriodS: 1800, updates: "none" })
	assert.equal(connectivityFromRequest("add firmware updates", undefined).updates, "ota")
})

test("Home Assistant over Wi-Fi: the rail grows for the radio, uploads stretch until the battery target holds, and it settles", { timeout: 240_000 }, async () => {
	const out = tempDir()
	const r = await runDesign({ brief: readFileSync("briefs/logger.md", "utf8"), mock: true, noHardware: true, review: false, outDir: out, changes: ["send the readings to Home Assistant over Wi-Fi every hour"], changeTimeoutMs: 30_000 })
	assert.equal(r.settled, true)
	assert.deepEqual(r.violations, [])
	const c = JSON.parse(readFileSync(join(out, "contract.json"), "utf8")).values
	assert.equal(c.connectivity.radio, "wifi")
	assert.ok(c.connectivity.uploadPeriodS > 3600, `uploads every ${c.connectivity.uploadPeriodS} s`)
	assert.ok(c.rails[0].loadMa >= 350, `rail peak ${c.rails[0].loadMa} mA`)
	const trace = readFileSync(join(out, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
	const seen = new Set(trace.filter((e) => e.type === "consistency.checked").flatMap((e) => e.payload.violations.map((v: { kind: string }) => v.kind)))
	assert.ok(seen.has("rail-underrated") && seen.has("battery-short"), [...seen].join(","))
	assert.ok(trace.some((e) => e.type === "artifact.ready" && e.payload.kind === "firmware" && e.payload.revision > 7), "the firmware rebuilt")
})
