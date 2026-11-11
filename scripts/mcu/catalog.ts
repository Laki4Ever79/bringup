// The catalog's MCU entries (catalog/parts.json, role "mcu") for the profiles Bringup can build a board for, so the parts
// agent's search_parts, the contract's catalog check and the grounding check see them. The ESP32-C3-MINI-1 entry is
// hand-written and left as it is; the others are generated from their profiles here:
//   npx tsx scripts/mcu/catalog.ts
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { chipPartPins } from "../../src/mcu/board.ts"
import { loadProfiles, type McuProfile } from "../../src/mcu/profile.ts"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))

export function catalogEntry(p: McuProfile) {
	return {
		ref: "U1",
		role: "mcu",
		mpn: p.mpn,
		lcsc: p.lcsc,
		footprint: p.package.footprint,
		pins: chipPartPins(p),
		profile: p.id,
		sleepUa: p.currents.sleepUa,
		cpuMa: p.currents.cpuMa,
		supplyMinMa: p.currents.supplyMinMa,
		flashMb: +(p.flashKb / 1024).toFixed(3),
		notes: `${p.vendor} ${p.family}, ${p.core} ${p.mhz} MHz, ${p.flashKb} KB flash, ${p.ramKb} KB RAM, ${p.package.name}; radio: ${p.radio.join(", ") || "none"}; programmed over ${p.programming.method}. ${p.firmware.history ? `Its ${p.flashKb} KB flash holds the firmware; the reading history goes in ${p.firmware.history.store === "eeprom" ? "the core's EEPROM emulation" : "a LittleFS partition"}, ${p.firmware.history.bytes} bytes (${Math.floor(p.firmware.history.bytes / 4)} readings), so no external memory part is needed. ` : ""}Generated from its MCU profile (catalog/mcu/${p.id}.json): ${p.currents.source}`,
	}
}

// Edits the file as text, one part per line, so the hand-written entries keep their layout: generated lines (they carry
// "profile") are replaced, after the last hand-written MCU line.
function main() {
	const path = join(ROOT, "catalog/parts.json")
	const lines = readFileSync(path, "utf8").replace(/\n$/, "").split("\n")
	const body = lines.slice(1, -1).map((l) => l.replace(/,$/, "")).filter((l) => !/"profile": "/.test(l))
	const line = (x: unknown) => "\t" + JSON.stringify(x, null, 1).replace(/\n\s*/g, " ").replace(/\[ /g, "[").replace(/ \]/g, "]")
	const generated = loadProfiles().filter((p) => p.kind === "chip" && p.board.supported).map((p) => line(catalogEntry(p)))
	const at = body.findLastIndex((l) => /"role": "mcu"/.test(l)) + 1
	const out = [...body.slice(0, at), ...generated, ...body.slice(at)]
	writeFileSync(path, `[\n${out.join(",\n")}\n]\n`)
	JSON.parse(readFileSync(path, "utf8"))
	console.log(`catalog: ${generated.length} generated MCU entries`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
