import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { holesFromCircuitJson, netsFromCircuitJson, partsFromCircuitJson, placementsFromCircuitJson } from "../src/tools/board-nets.ts"

// Built by tsci from circuitFromContract(fixtureContract()).
const elements = JSON.parse(readFileSync(new URL("./data/fixture.circuit.json", import.meta.url), "utf8"))

test("nets map signal names to REF.pinLabel ends", () => {
	const nets = netsFromCircuitJson(elements)
	assert.deepEqual(nets.I2C_SDA?.slice().sort(), ["U1.GPIO8", "U2.SDA"])
	assert.deepEqual(nets.I2C_SCL?.slice().sort(), ["U1.GPIO9", "U2.SCL"])
})

test("a net with no traces is listed empty", () => {
	const nets = netsFromCircuitJson([{ type: "source_net", source_net_id: "n0", name: "SPARE" }])
	assert.deepEqual(nets, { SPARE: [] })
})

test("holes come back in the contract frame: from the board's bottom-left corner", () => {
	const holes = holesFromCircuitJson([
		{ type: "pcb_board", width: 50, height: 30 },
		{ type: "pcb_hole", hole_shape: "circle", hole_diameter: 2.2, x: -22, y: -12 },
		{ type: "pcb_hole", hole_shape: "circle", hole_diameter: 2.2, x: 22, y: 12 },
		// A footprint's own hole (the USB-C locating pegs) is not a mounting hole.
		{ type: "pcb_hole", hole_shape: "circle", hole_diameter: 0.7, x: -17.9, y: 2.9, pcb_component_id: "pcb_component_3" },
	])
	assert.deepEqual(holes, [{ xMm: 3, yMm: 3, diameterMm: 2.2 }, { xMm: 47, yMm: 27, diameterMm: 2.2 }])
})

test("parts come back as placed: each component's MPN (null when the board has none) and its pins", () => {
	const parts = partsFromCircuitJson([
		{ type: "source_component", source_component_id: "c1", name: "U3", manufacturer_part_number: "AP2112K-3.3TRG1" },
		{ type: "source_component", source_component_id: "c2", name: "R1" },
		{ type: "source_port", source_port_id: "p1", source_component_id: "c1", name: "VIN" },
		{ type: "source_port", source_port_id: "p2", source_component_id: "c1", name: "VOUT" },
		{ type: "source_port", source_port_id: "p3", source_component_id: "c2", name: "pin1" },
	])
	assert.deepEqual(parts, { U3: { mpn: "AP2112K-3.3TRG1", pins: ["VIN", "VOUT"] }, R1: { mpn: null, pins: ["pin1"] } })
})

test("placements come back in the contract frame: each component's centre from the board's bottom-left corner", () => {
	const placements = placementsFromCircuitJson([
		{ type: "pcb_board", width: 50, height: 30 },
		{ type: "source_component", source_component_id: "s1", name: "U2" },
		{ type: "pcb_component", source_component_id: "s1", center: { x: 21.5, y: 11 } },
		{ type: "source_component", source_component_id: "s2", name: "unplaced" },
	])
	assert.deepEqual(placements, { U2: { xMm: 46.5, yMm: 26 } })
})
