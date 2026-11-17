// Open standards by default (the user, 15 Nov 2026, asked whether we insist on them; recommended yes): every interface a
// design has, which standard it follows, and whether that standard is open (anyone may read and implement it), one
// vendor's, or our own. A vendor-locked or home-made interface names its open alternative, so the report can say what
// a change to an open one would take. Plain code from the contract; no guesses about parts it doesn't carry.
import { debugPinout, usbRef } from "../codegen/circuit.ts"
import type { ContractSnapshot } from "./types.ts"

export type Openness = "open" | "vendor" | "ours"

export interface InterfaceRow {
	interface: string
	standard: string
	openness: Openness
	// For "vendor" and "ours": the open standard that would do the job, and what moving to it costs.
	alternative?: string
}

export function interfacesOf(s: ContractSnapshot): InterfaceRow[] {
	const v = s.values
	const out: InterfaceRow[] = []
	if (usbRef(s)) out.push({ interface: "USB-C port (power, flashing, serial)", standard: "USB Type-C and USB 2.0 (USB-IF; the specifications are free to download)", openness: "open" })
	const links = v.links ?? []
	if (links.some((l) => l.kind === "i2c")) out.push({ interface: "I²C link between boards", standard: "I²C (NXP UM10204, freely published)", openness: "open" })
	if (links.some((l) => l.kind === "uart")) out.push({ interface: "UART link between boards", standard: "asynchronous serial, 8N1 (a de facto standard; no owner)", openness: "open" })
	// A CAN bus of more than two boards (link.can.bus): this board daisy-chains it, terminated only at the bus's two ends.
	const canLinks = links.filter((l) => l.kind === "can")
	const bus = canLinks.find((l) => l.can?.bus)?.can?.bus
	const middle = canLinks.length > 0 && canLinks.every((l) => l.can && !l.can.terminate)
	if (canLinks.length)
		out.push({
			interface: bus ? `CAN bus ${bus} between boards (physical and frames; this board ${middle ? "in the middle of the daisy chain" : "at one end"})` : "CAN link between boards (physical and frames)",
			standard: bus ? `ISO 11898-1/-2 (CAN): one bus, 120 Ω at its two ends only (${middle ? "not here" : "here"}); each node's stub is its board trace to the transceiver, under ISO 11898-2's 0.3 m at 1 Mbit/s` : "ISO 11898-1/-2 (CAN), 120 Ω terminated",
			openness: "open",
		})
	if (links.some((l) => l.connector)) out.push({ interface: "link connector (JST SH 4-pin, 1 mm)", standard: "JST's SH series; the pin order is SparkFun's Qwiic convention (open)", openness: "vendor", alternative: "the footprint is JST's, but second sources make compatible 1 mm 4-pin housings; the pinout is already the open Qwiic one" })
	// The messages over a link on UART and I2C: open framing (COBS, CRC-16/CCITT) around a CBOR payload (16 Nov 2026;
	// before, the message's packed C struct).
	if (links.some((l) => (l.kind === "uart" || l.kind === "i2c") && l.messages?.length))
		out.push({ interface: "messages over UART/I²C links (templates/fw/include/linkframe.h, linkcbor.h)", standard: "COBS framing (Cheshire and Baker, IEEE/ACM ToN 1999) and CRC-16/CCITT around a CBOR payload (RFC 8949: a map of the message's field names to their values), all open; the frame also carries the message definition's hash", openness: "open" })
	if (links.some((l) => l.kind === "can" && l.messages?.length))
		out.push({ interface: "messages over a CAN link (templates/fw/include/linkcyphal.h)", standard: "Cyphal/CAN v1.0 (OpenCyphal, open specification, MIT-licensed tools): single-frame message transfers, a subject-ID and node-ID in the 29-bit identifier, DSDL-serialized fields and the tail byte; a .dsdl file per message lets yakut or pycyphal read the bus", openness: "open" })
	if (v.requirements?.debugPort !== false && v.outline && debugPinout(s))
		out.push({ interface: "debug footprint (Tag-Connect TC2030-NL, underside)", standard: "Tag-Connect's cable and footprint (the footprint is free to use; the cable is theirs); ARM's SWD pinout or Espressif's UART-download pins on it", openness: "vendor", alternative: "ARM's 10-pin 0.05\" Cortex Debug connector (an open pinout every SWD probe takes), at about 6 × 6 mm of top-side room; or bare test pads" })
	const c = v.connectivity
	if (c?.report.includes("bthome")) out.push({ interface: "readings over BLE advertising", standard: "BTHome v2 (bthome.io, open, read by Home Assistant)", openness: "open" })
	if (c?.report.includes("gatt")) out.push({ interface: "phone reads history over BLE", standard: "Bluetooth LE GATT (Bluetooth SIG, freely published); our own service and characteristic layout on it", openness: "ours", alternative: "a standard GATT profile where one fits (Environmental Sensing Service, ESS, for temperature and humidity)" })
	if (c?.report.includes("mqtt")) out.push({ interface: "readings over Wi-Fi", standard: "MQTT 3.1.1 (OASIS) with Home Assistant's discovery topics", openness: "open" })
	if (c?.updates === "ota") out.push({ interface: "firmware updates over Wi-Fi", standard: "HTTPS download into the ESP-IDF OTA partitions (ESP-IDF's layout)", openness: "vendor", alternative: "none open fits a bare ESP32 well; MCUboot (Apache-2.0) is the open bootloader where the chip supports it" })
	// The files every run writes.
	out.push({ interface: "design files", standard: "KiCad project (GPL-3.0 tool, open S-expression format), Gerber X2 (Ucamco, published), STEP AP214 (ISO 10303-21), STL", openness: "open" })
	out.push({ interface: "parts list (SBOM)", standard: "CycloneDX (OWASP, ECMA-424)", openness: "open" })
	out.push({ interface: "firmware build", standard: "PlatformIO and the Arduino core (open source)", openness: "open" })
	return out
}

// For the agents (design facts): the rule, and each interface that isn't open with its open alternative (the user,
// 15 Nov 2026: open standards by default). The open ones need no line: they are already what the rule asks.
export function standardsFactLines(s: ContractSnapshot): string[] {
	const locked = interfacesOf(s).filter((r) => r.openness !== "open")
	return [
		"",
		"## Interfaces and standards (open standards by default)",
		"- Rule: where an open standard fits the job (anyone may read and implement it), choose it over a vendor's or a home-made one; keep a non-open one only when no open option fits, and say why in the part's or field's reason.",
		...locked.map((r) => `- ${r.interface}: ${r.openness === "vendor" ? "one vendor's" : "Bringup's own"} (${r.standard}). Open alternative: ${r.alternative}`),
	]
}

// The report's section: a table of every interface, then the ones that aren't open with their alternatives.
export function standardsSection(s: ContractSnapshot): string[] {
	const rows = interfacesOf(s)
	const locked = rows.filter((r) => r.openness !== "open")
	const label = { open: "open", vendor: "one vendor's", ours: "Bringup's own" } as const
	return [
		"## Interfaces and standards",
		"",
		`${rows.length} interfaces; ${rows.length - locked.length} on open standards, ${locked.filter((r) => r.openness === "vendor").length} one vendor's, ${locked.filter((r) => r.openness === "ours").length} Bringup's own.`,
		"",
		"| Interface | Standard | Open? |",
		"|---|---|---|",
		...rows.map((r) => `| ${r.interface} | ${r.standard} | ${label[r.openness]} |`),
		...(locked.length ? ["", "Not open, and the open alternative:", ...locked.map((r) => `- ${r.interface}: ${r.alternative}`)] : []),
		"",
	]
}
