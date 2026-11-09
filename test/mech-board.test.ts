// The rover's board (src/codegen/circuit.ts): the DRV8833 motor driver, two motor connectors and the distance sensor's
// connector, wired by the generator.
import { test } from "node:test"
import assert from "node:assert/strict"
import { generatedNets, linkBusTraces, supportParts } from "../src/codegen/circuit.ts"
import { unconnectedParts } from "../src/contract/consistency.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

const rover = (): ContractSnapshot => ({ revision: 1, versions: {} as ContractSnapshot["versions"], values: JSON.parse(JSON.stringify(ROVER_BOARD)) })

test("the driver's motor supply is the cell (VBAT), never the 3V3 rail", () => {
	const nets = generatedNets(rover())
	assert.ok(nets.get("VBAT")!.includes("U5.VM"))
	assert.ok(!nets.get("V3V3")!.includes("U5.VM"))
	assert.ok(nets.get("GND")!.includes("U5.AISEN") && nets.get("GND")!.includes("U5.BISEN"), "no current sensing: the sense pins to ground")
})

test("each driver output reaches its motor connector", () => {
	const nets = generatedNets(rover())
	for (const [net, a, b] of [["MOTOR_A1", "U5.AOUT1", "JM1.1"], ["MOTOR_A2", "U5.AOUT2", "JM1.2"], ["MOTOR_B1", "U5.BOUT1", "JM2.1"], ["MOTOR_B2", "U5.BOUT2", "JM2.2"]])
		assert.deepEqual(nets.get(net)?.sort(), [a, b].sort(), net)
})

test("the sensor connector gets 3V3; the driver gets its datasheet capacitors and a wake pull-up", () => {
	const s = rover()
	assert.ok(generatedNets(s).get("V3V3")!.includes("JT1.VCC"))
	const jobs = supportParts(s).map((p) => p.job).join("\n")
	assert.match(jobs, /U5\.VM bulk/)
	assert.match(jobs, /U5\.VINT/)
	assert.match(jobs, /U5\.VCP/)
	assert.match(jobs, /U5\.nSLEEP pull-up/)
})

test("the sensor plug joins the I2C bus through the generator, in the STEMMA QT order", () => {
	assert.deepEqual(linkBusTraces(rover()), [{ ref: "JT1", pin: "IO1", net: "I2C_SDA" }, { ref: "JT1", pin: "IO2", net: "I2C_SCL" }])
})

test("one pull-up per I2C line, however many parts share the bus", () => {
	const jobs = supportParts(rover()).filter((p) => /^I2C_(SDA|SCL) pull-up/.test(p.job))
	assert.equal(jobs.length, 2)
})

test("nothing on the rover board is left unconnected", () => {
	assert.deepEqual(unconnectedParts(rover()), [])
})
