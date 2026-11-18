// A PWM driver comes with what it drives (real run 20b, Eurobot: the PCA9685 U6 had no servo plug, no servo supply and
// no spare motor plug): contract/outputs-auto.ts, then the power tree's supply chip, then the board's nets.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { withDriverOutputs } from "../src/contract/outputs-auto.ts"
import { completePowerTree } from "../src/contract/power-auto.ts"
import { loadCatalog } from "../src/tools/parts-search.ts"
import { generatedNets, servoOutputs } from "../src/codegen/circuit.ts"
import { roverHeader } from "../src/mechanics/firmware.ts"
import { roverFirmwareFacts } from "../src/agents/design-facts.ts"
import { withStatusLed } from "../src/contract/status-led-auto.ts"
import { unreservedGpios } from "../src/contract/mcu-move.ts"
import { mcuProfileOf } from "../src/mcu/profile.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

const catalog = loadCatalog(fileURLToPath(new URL("..", import.meta.url))) as never
const run20b = () => JSON.parse(readFileSync(new URL("./fixtures/cc-eurobot-20b-final.json", import.meta.url), "utf8")) as ContractSnapshot
const fixed = () => {
	const s = run20b()
	const o = withDriverOutputs(s.values.parts!, catalog, s.values.mechanics)
	s.values.parts = completePowerTree(o.parts, s.values.mechanics ?? undefined, s).parts
	return { s, note: o.note }
}

test("run 20b: the PCA9685 gets two servo plugs, a servo supply chip and the spare motor (driver + JM3), once", () => {
	const before = servoOutputs(run20b().values.parts!)!
	assert.equal(before.servos.length, 0)
	assert.equal(before.supply, undefined)
	assert.equal(before.spare, undefined)
	const { s, note } = fixed()
	assert.match(note!, /JV1 and JV2/)
	const so = servoOutputs(s.values.parts!)!
	assert.deepEqual(so.servos.map((p) => p.ref), ["JV1", "JV2"])
	assert.ok(so.supply?.lcsc, `an assembled chip, got ${so.supply?.mpn}`)
	assert.equal(so.spare?.mpn, "DRV8833PWPR")
	assert.ok(s.values.parts!.some((p) => p.ref === "JM3"))
	assert.equal(new Set(s.values.parts!.map((p) => p.ref)).size, s.values.parts!.length, "refs unique")
	assert.equal(withDriverOutputs(s.values.parts!, catalog, s.values.mechanics).note, null, "added once")
})

test("run 20b after: the board wires them and the firmware facts count them and name the real supply", () => {
	const { s } = fixed()
	const n = generatedNets(s)
	assert.ok(n.get("SERVO1")?.includes("JV1.SIG") && n.get("SERVO2")?.includes("JV2.SIG"))
	assert.ok(n.get("SERVO_5V")?.includes("JV1.V5"))
	assert.ok([...n.values()].some((ends) => ends.includes("JM3.M1")), "spare motor plug driven")
	assert.match(roverHeader(s), /#define SERVO_COUNT 2/)
	assert.match(roverHeader(s), /#define SPARE_MOTOR_CH 2/)
	const fact = roverFirmwareFacts(s).find((l) => l.includes("PCA9685"))!
	const supply = s.values.parts!.find((p) => p.role === "servo-supply")!
	assert.ok(fact.includes(`${supply.ref} ${supply.mpn}`), fact)
	const bare = run20b()
	assert.match(roverFirmwareFacts(bare).find((l) => l.includes("PCA9685"))!, /no servo supply/)
})

test("no PWM driver, nothing added; a skid-steer base gets no spare driver", () => {
	const s = run20b()
	const noPwm = s.values.parts!.filter((p) => p.role !== "pwm-driver")
	assert.equal(withDriverOutputs(noPwm, catalog, s.values.mechanics).note, null)
	const skid = withDriverOutputs(s.values.parts!, catalog, { ...s.values.mechanics!, drive: { ...s.values.mechanics!.drive, kind: "skid4" } })
	assert.equal(skid.parts.filter((p) => p.role === "motor-driver").length, 1)
})

test("run 20b: no temperature/humidity sensor, so the firmware facts claim no payload", () => {
	const facts = roverFirmwareFacts(run20b())
	assert.ok(!facts.some((l) => /reads the .*temperature\/humidity sensor/.test(l)))
	assert.ok(facts.some((l) => l.startsWith("- Firmware payload: none")))
})

test("run 20b: the robot gets its status LED: an LED part and STATUS_LED on a pin free at reset, once", () => {
	const s = run20b()
	assert.ok(!s.values.pins!.some((p) => p.signal === "STATUS_LED"), "before: none")
	const r = withStatusLed(s.values.parts!, s.values.pins!, s.values.mechanics, s.values.motion, catalog)!
	const pin = r.pins.find((p) => p.signal === "STATUS_LED")!
	const led = r.parts.find((p) => p.ref === pin.partRef)!
	assert.equal(led.role, "led")
	assert.equal(pin.partPin, "A")
	assert.ok(unreservedGpios(mcuProfileOf(r.parts)!).includes(pin.gpio), "free at reset")
	assert.ok(!s.values.pins!.some((p) => p.gpio === pin.gpio), "not a used pin")
	s.values.parts = r.parts
	s.values.pins = r.pins
	assert.match(roverHeader(s), new RegExp(`#define PIN_STATUS_LED ${pin.gpio}`))
	assert.equal(withStatusLed(r.parts, r.pins, s.values.mechanics, s.values.motion, catalog), null, "added once")
	assert.equal(withStatusLed(run20b().values.parts!, run20b().values.pins!, null, null, catalog), null, "no drive, no LED")
})

