import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { complianceItems, complianceMarkdown, MODULE_FCC_ID } from "../src/contract/compliance.ts"
import { sbomComponents, sbomJson } from "../src/tools/sbom.ts"
import { defaultTestSpec, testPlan, testPlanMarkdown } from "../src/contract/testkit.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import type { Connectivity } from "../src/contract/types.ts"
import { fixtureContract } from "./fixture.ts"

const root = resolve(import.meta.dirname, "..")
const design = (connectivity?: Connectivity) => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN), ...(connectivity ? { connectivity } : {}) }
	return s
}
const status = (s: ReturnType<typeof design>, item: RegExp) => complianceItems(s).find((i) => item.test(i.item))?.status

test("the checklist follows the design: BLE pairing, Wi-Fi TLS, BTHome in the clear, updates", () => {
	const ble = design()
	assert.equal(status(ble, /no universal default password/), "met")
	assert.equal(status(ble, /security updates/), "open")
	assert.equal(status(ble, /which parts apply/), "check")
	const ha = design({ radio: "ble", report: ["gatt", "bthome"], updates: "none" })
	assert.equal(status(ha, /broadcast in the clear/), "check")
	const wifi = design({ radio: "wifi", report: ["mqtt"], uploadPeriodS: 3600, updates: "ota" })
	assert.equal(status(wifi, /which parts apply/), "met")
	assert.equal(status(wifi, /protected communication/), "met")
	assert.equal(status(wifi, /security updates/), "met")
	assert.equal(status(wifi, /secure update mechanism/), "open", "HTTPS, but no signed image")
	assert.match(complianceMarkdown(wifi), /Not legal advice/)
	assert.match(complianceMarkdown(wifi), new RegExp(`Contains FCC ID: ${MODULE_FCC_ID}`))
})

test("the SBOM lists only what this design's firmware links, at the pinned and installed versions", () => {
	const ini = readFileSync(join(root, "templates/fw/platformio.ini"), "utf8")
	const names = (s: ReturnType<typeof design>) => sbomComponents(s, ini).map((c) => c.name)
	assert.ok(names(design()).includes("NimBLE-Arduino") && !names(design()).includes("PubSubClient"))
	const wifi = design({ radio: "wifi", report: ["mqtt"], uploadPeriodS: 3600, updates: "none" })
	assert.ok(names(wifi).includes("PubSubClient") && !names(wifi).includes("NimBLE-Arduino"))
	assert.equal(sbomComponents(design(), ini).find((c) => c.name === "NimBLE-Arduino")?.version, "2.5.2")
	const bom = JSON.parse(sbomJson(design(), ini, 7))
	assert.equal(bom.bomFormat, "CycloneDX")
	assert.equal(bom.metadata.component.version, "rev 7")
})

test("the factory test plan tells the station to label each device with its passkey and the FCC ID", () => {
	const s = design()
	s.values.test = defaultTestSpec(s)
	const md = testPlanMarkdown(testPlan(s), s)
	assert.match(md, /BRINGUP-TEST identity mac=<MAC> passkey=<6 digits>/)
	assert.match(md, /Contains FCC ID: 2AC7Z-ESPC3MINI1/)
})

test("the product firmware has no shared password and refuses plaintext unless told: pairing, TLS, HTTPS", () => {
	const main = readFileSync(join(root, "templates/fw/src/main.cpp"), "utf8")
	assert.match(main, /setSecurityAuth\(true, true, true\)/)
	assert.match(main, /READ_AUTHEN/)
	assert.match(main, /MQTT refused: no MQTT_CA/)
	assert.match(main, /OTA refused: no OTA_CA/)
	assert.doesNotMatch(main, /setSecurityPasskey\(\d/, "no passkey literal")
})
