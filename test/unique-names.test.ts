// Two children of one name make tscircuit refuse the board ("Multiple immediate children found with name ESTOP_TRIP"):
// the CNC's shared STEPPER_UART and ESTOP_TRIP were declared once per contract pin (lead-3's CNC mock 15 rev 9).
import { test } from "node:test"
import assert from "node:assert/strict"
import { uniqueNames } from "../src/codegen/circuit.ts"

test("one <net> per name, the one with a trace width kept; a repeated connection dropped; another trace renamed", () => {
	const out = uniqueNames([
		`<net name="UART" />`,
		`<trace name="UART_mcu" from=".U1 > .PA2" to="net.UART" />`,
		`<net name="UART" />`,
		`<trace name="UART_mcu" from=".U1 > .PA2" to="net.UART" />`,
		`<trace name="UART_part" from=".U4 > .PDN" to="net.UART" />`,
		`<trace name="UART_part" from=".U5 > .PDN" to="net.UART" />`,
		`<net name="VMOT" />`,
		`<net name="VMOT" nominalTraceWidth="1.2mm" />`,
		`<chip name="U1" />`,
	])
	assert.deepEqual(out, [
		`<net name="UART" />`,
		`<trace name="UART_mcu" from=".U1 > .PA2" to="net.UART" />`,
		`<trace name="UART_part" from=".U4 > .PDN" to="net.UART" />`,
		`<trace name="UART_part_2" from=".U5 > .PDN" to="net.UART" />`,
		`<net name="VMOT" nominalTraceWidth="1.2mm" />`,
		`<chip name="U1" />`,
	])
})
