// What a failed board build says, and what it leads to (bringup-lead's robot runs, 15 Nov 2026). tscircuit's "Routes
// contain a junction or endpoint that cannot select a unique PCB port" shows on builds that succeed too, so it is never
// the cause; the build said little else when the cause was in circuit.json only ("exit 1 and no named error"), and the
// architect was told to give the board room, five times over, for a trace past its length bound.
import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildErrors, circuitErrors, layoutSensitive } from "../src/tools/board.ts"
import { ROUTING_FAILURE } from "../src/contract/space.ts"
import { tempDir } from "./helpers.ts"

const PORT = "Could not save autorouting paths for subcircuit_source_group_0: Routes contain a junction or endpoint that cannot select a unique PCB port"

test("the router's port warning is never the cause: not a routing failure, and not in the build's errors", () => {
	assert.doesNotMatch(PORT, ROUTING_FAILURE)
	const out = ["phase 1/1 done: routed_traces=79, jumpers=0, errors=0", PORT, "PCB trace is 6.08mm long, exceeding the 5mm maximum", "Circuits  0 passed 1 failed", "⚠ Build completed with errors"].join("\n")
	const e = buildErrors(out)
	assert.match(e, /6\.08mm long, exceeding the 5mm maximum/)
	assert.doesNotMatch(e, /unique PCB port/)
})

test("a failed build names the errors tscircuit wrote into circuit.json", () => {
	const dir = tempDir()
	const file = join(dir, "circuit.json")
	writeFileSync(file, JSON.stringify([
		{ type: "source_component", name: "J1" },
		{ type: "source_trace_not_connected_error", message: 'Could not find port for selector ".J1 > .GND". Component ".J1 > " found, but does not have pin "GND". It has no ports' },
		{ type: "source_trace_not_connected_error", message: 'Could not find port for selector ".J1 > .GND". Component ".J1 > " found, but does not have pin "GND". It has no ports' },
		{ type: "pcb_trace_too_long_error", message: "PCB trace is 25.47mm long, exceeding the 5mm maximum", source_trace_id: "t1" },
		{ type: "source_trace", source_trace_id: "t1", display_name: ".C6 > .pin2 to net.GND" },
	]))
	assert.deepEqual(circuitErrors(file), ['Could not find port for selector ".J1 > .GND". Component ".J1 > " found, but does not have pin "GND". It has no ports', "PCB trace is 25.47mm long, exceeding the 5mm maximum (.C6 > .pin2 to net.GND)"])
	assert.deepEqual(circuitErrors(join(dir, "none.json")), [])
})

test("a trace past its length bound tries the next layout; a missing part's footprint does not", () => {
	assert.equal(layoutSensitive("PCB trace is 6.08mm long, exceeding the 5mm maximum"), true)
	assert.equal(layoutSensitive("Courtyard of C4 overlaps with courtyard of U5"), true)
	assert.equal(layoutSensitive(PORT), false)
	assert.equal(layoutSensitive("Unknown footprint 'sot99' for U3"), false)
})
