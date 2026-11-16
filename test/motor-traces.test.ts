// The motor outputs' track width (src/codegen/circuit.ts supplyWidths): a motor's stall current at the pack's full
// voltage, IPC-2221, when that is over the default 0.15 mm track. Today's rovers stay at the default.
import { test } from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_TRACE_MM, motorStallA, netTraceWidths, supplyWidths } from "../src/codegen/circuit.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

const snap = (edit: (v: any) => void = () => {}): ContractSnapshot => { // eslint-disable-line @typescript-eslint/no-explicit-any
	const v = JSON.parse(JSON.stringify(ROVER_BOARD))
	edit(v)
	return { revision: 1, versions: {} as never, values: v }
}

test("the reference rover's motors (0.47 A stall on one cell) keep the default track", () => {
	assert.ok(Math.abs(motorStallA(snap())! - 0.469) < 0.01)
	assert.equal(supplyWidths(snap()).has("MOTOR_A1"), false)
})

test("a high-power motor's outputs get IPC-2221 width for its stall current", () => {
	const s = snap((v) => (v.mechanics.drive.motor = "POLOLU-998 50:1 HP 6V"))
	assert.ok(motorStallA(s)! > 1)
	const w = supplyWidths(s).get("MOTOR_A1")!
	assert.ok(w > DEFAULT_TRACE_MM)
	for (const n of ["MOTOR_A1", "MOTOR_A2", "MOTOR_B1", "MOTOR_B2"]) assert.equal(netTraceWidths(s).get(n), w)
})

test("a board with no motor driver has no motor width", () => {
	assert.equal(motorStallA(snap((v) => (v.parts = v.parts.filter((p: { role: string }) => p.role !== "motor-driver")))), null)
})
