import assert from "node:assert/strict"
import { test } from "node:test"
import type { BoardPart } from "../src/codegen/circuit.ts"
import { bomCsv, cplCsv, zipEntries, zipStore } from "../src/tools/fab.ts"

const part = (ref: string, lcsc: string | null, mpn = `MPN-${lcsc}`, footprint = "0402", value: string | null = null): BoardPart => ({ ref, mpn, lcsc, footprint, value, added: false })

test("bom.csv has JLC's headers and groups identical parts by LCSC number", () => {
	const csv = bomCsv([part("R10", "C25744"), part("U1", "C2838502", "ESP32-C3-MINI-1", "esp32_c3_mini_1"), part("R2", "C25744"), part("R1", "C11702", "0402WGF1001TCE", "0402", "1k")])
	const lines = csv.trim().split("\n")
	assert.equal(lines[0], "Comment,Designator,Footprint,LCSC Part #")
	assert.equal(lines.length, 4)
	assert.ok(lines.includes('"MPN-C25744","R2,R10","0402","C25744"'), csv)
	assert.ok(lines.includes('"1k","R1","0402","C11702"'), "an added passive's comment is its value")
	assert.ok(lines.includes('"ESP32-C3-MINI-1","U1","esp32_c3_mini_1","C2838502"'))
})

test("bom.csv keeps parts without an LCSC number, grouped by MPN", () => {
	const csv = bomCsv([part("SW1", null, "X"), part("SW2", null, "X"), part("J9", null, "Y")])
	assert.ok(csv.includes('"X","SW1,SW2","0402",""'), csv)
	assert.ok(csv.includes('"Y","J9","0402",""'), csv)
})

test("cpl.csv maps KiCad's position file to JLC's columns and 0-360 rotations", () => {
	const pos = [
		"Ref,Val,Package,PosX,PosY,Rot,Side",
		'"C1","","chip_0402",90.500000,-108.500000,0.000000,top',
		'"J1","J1","connector_usbcmidmount",81.000000,-100.000000,-90.000000,top',
		'"U9","","chip",100.000000,-100.000000,180.000000,bottom',
	].join("\n")
	assert.equal(
		cplCsv(pos),
		["Designator,Mid X,Mid Y,Layer,Rotation", "C1,90.5mm,-108.5mm,Top,0", "J1,81mm,-100mm,Top,270", "U9,100mm,-100mm,Bottom,180", ""].join("\n"),
	)
})

test("zip round-trips: stored entries come back byte for byte", () => {
	const files = [
		{ name: "board-Edge_Cuts.gm1", data: Buffer.from("G04 edge*\nM02*\n") },
		{ name: "board.drl", data: Buffer.from("M48\nM30\n") },
	]
	const zip = zipStore(files)
	assert.equal(zip.readUInt32LE(0), 0x04034b50, "local file header signature")
	assert.deepEqual(zipEntries(zip).map((e) => [e.name, e.data.toString()]), files.map((f) => [f.name, f.data.toString()]))
})
