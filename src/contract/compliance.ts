import { connectivityOf } from "./connectivity.ts"
import type { ContractSnapshot } from "./types.ts"

// A compliance checklist for the design, from what the design and its firmware do: where it stands against the US FCC
// module grant and the EU rules for radio products. Each item says met, open (work left) or check (it depends on how
// the product is used). Not legal advice: a compliance professional decides; this says what the design can show.
export type ComplianceStatus = "met" | "open" | "check"

export interface ComplianceItem {
	rule: string
	item: string
	status: ComplianceStatus
	why: string
}

// ESP32-C3-MINI-1: Espressif "ESP32-C3-MINI-1 FCC Certification.pdf" (grant 16 Jun 2021, single modular).
export const MODULE_FCC_ID = "2AC7Z-ESPC3MINI1"

export function complianceItems(s: ContractSnapshot): ComplianceItem[] {
	const c = connectivityOf(s)
	const wifi = c.radio === "wifi"
	const gatt = c.report.includes("gatt")
	const bthome = c.report.includes("bthome")
	const mcu = (s.values.parts ?? []).find((p) => p.role === "mcu")
	const items: ComplianceItem[] = []
	const fcc = "US FCC (module grant)"
	if (mcu?.mpn === "ESP32-C3-MINI-1") {
		items.push({ rule: fcc, item: `the product's label says "Contains FCC ID: ${MODULE_FCC_ID}"`, status: "open", why: "the label isn't designed yet (the case lettering takes 24 characters)" })
		items.push({ rule: fcc, item: "used 20 cm or more from people, not body-worn", status: "check", why: "the module's grant covers mobile or fixed use; a wearable or handheld product needs its own approval" })
		items.push({ rule: fcc, item: "the module's own PCB antenna, unmodified", status: "met", why: "the board keeps the module's antenna, at the board edge as Espressif recommends" })
	}
	const red = "EU RED cybersecurity, Delegated Regulation (EU) 2022/30 (applies since 1 Aug 2025), EN 18031"
	items.push({
		rule: red,
		item: "which parts apply",
		status: wifi ? "met" : "check",
		why: wifi ? "Wi-Fi to an MQTT broker makes it internet-connected: EN 18031-1 applies" : "Bluetooth LE only: EN 18031-1 (internet-connected) may not apply; EN 18031-2 does if its readings count as personal data",
	})
	if (gatt) items.push({ rule: red, item: "no universal default password", status: "met", why: "Bluetooth history reads need pairing with the device's own passkey, made by its hardware random generator and printed on its label (identity.h)" })
	if (wifi) items.push({ rule: red, item: "no universal default password", status: "met", why: "Wi-Fi and broker credentials come per installation from the engineer's own secrets.h; none are built in" })
	if (wifi) items.push({ rule: red, item: "protected communication", status: "met", why: "MQTT over TLS against the broker's CA by default; plain only when the engineer sets MQTT_ALLOW_PLAINTEXT" })
	if (bthome) items.push({ rule: red, item: "readings broadcast in the clear", status: "check", why: "BTHome advertising is unencrypted: anyone nearby reads the temperature and humidity (BTHome's own encryption, with a key per device, is not built)" })
	if (c.updates === "ota") items.push({ rule: red, item: "secure update mechanism", status: "open", why: "updates come over HTTPS against OTA_CA, but the image isn't signed, and Secure Boot can't be enabled from a stock Arduino build" })
	const cra = "EU Cyber Resilience Act, Regulation (EU) 2024/2847 (reporting from 11 Sep 2026, everything else from 11 Dec 2027)"
	items.push({ rule: cra, item: "software bill of materials", status: "met", why: "sbom.cdx.json, generated with every firmware build from the installed and pinned versions" })
	items.push({ rule: cra, item: "secure by default", status: "met", why: `${gatt ? "paired, encrypted Bluetooth reads" : "no open Bluetooth service"}${wifi ? "; TLS for MQTT and updates unless explicitly allowed otherwise" : ""}; no default password` })
	items.push({
		rule: cra,
		item: "security updates for the support period (5 years unless the product lives shorter)",
		status: c.updates === "ota" ? "met" : "open",
		why: c.updates === "ota" ? "field updates over Wi-Fi (connectivity.updates \"ota\")" : "no field updates: a vulnerability can only be fixed by reflashing over USB",
	})
	items.push({ rule: cra, item: "vulnerability handling: a contact and a disclosure policy, reporting to ENISA within 24 h", status: "open", why: "the manufacturer's process, not the design: name the contact before selling" })
	items.push({ rule: cra, item: "stored data protected", status: "open", why: "the reading history sits unencrypted in flash: flash encryption can't be enabled from a stock Arduino build" })
	items.push({ rule: cra, item: "the user can erase all data and settings", status: "open", why: "the firmware has no factory reset yet" })
	return items
}

export function complianceMarkdown(s: ContractSnapshot): string {
	const items = complianceItems(s)
	const mark = { met: "met", open: "**open**", check: "check" }
	const rows = items.map((i) => `| ${i.rule} | ${i.item} | ${mark[i.status]} | ${i.why} |`)
	const n = (st: ComplianceStatus) => items.filter((i) => i.status === st).length
	return [
		`# Compliance checklist (revision ${s.revision})`,
		"",
		`${n("met")} met, ${n("open")} open, ${n("check")} to check. Generated from the design and its firmware. Not legal advice: a compliance professional decides; this says what the design can show.`,
		"",
		"| Rule | Item | Status | Why |",
		"| --- | --- | --- | --- |",
		...rows,
		"",
	].join("\n")
}
