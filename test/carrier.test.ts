// The carrier of a bought compute board (src/system/carrier.ts): its brief, written from the Raspberry Pi 5 record, and
// the spec helper that adds it. No board is built here.
import { test } from "node:test"
import assert from "node:assert/strict"
import { resolve } from "node:path"
import { loadMechCatalog } from "../src/mechanics/catalog.ts"
import { moduleById } from "../src/system/bought.ts"
import { addCarrier, carrierBrief } from "../src/system/carrier.ts"
import { defaultAssembly, assemblyErrors } from "../src/system/assembly.ts"
import { specErrors, type SystemSpec } from "../src/system/spec.ts"

const pi = moduleById("rpi-5")!
const pack = loadMechCatalog(resolve(import.meta.dirname, "..")).batteries[0]

test("the carrier brief: 5 A at 5.1 V into pins 2 and 4, the Pi's outline and its holes 58 × 49 mm apart, the header where the record puts it", () => {
	const b = carrierBrief(pi, { board: "brain", battery: pack })
	assert.match(b, /^# Brief: carrier for the Raspberry Pi 5 \(brain\)/)
	assert.match(b, /5 V supply: 5 A at 5\.1 V\*\* from the robot's ADAFRUIT-258 .*\(3–4\.2 V\), so a boost converter, into header pins 2 and 4 \(5V\)/)
	assert.match(b, /ground on pins 6, 9, 14, 20, 25, 30, 34 and 39/)
	assert.match(b, /recommended supply and already includes its headroom, so no margin on top/)
	assert.match(b, /85 × 56 mm, with 4 Ø2\.7 mm mounting holes at \(3\.5, 3\.5\), \(61\.5, 3\.5\), \(3\.5, 52\.5\), \(61\.5, 52\.5\) mm from the lower-left corner, 58 × 49 mm between centres/)
	assert.match(b, /2 × 20 female header, 2\.54 mm pitch,\*\* centred at \(32\.5, 52\.5\) mm/)
	assert.match(b, /raspberry-pi-5-mechanical-drawing\.pdf/)
	assert.match(b, /power-supplies\.adoc/)
	// The default link is the MCU board's own USB: no link pins on the carrier.
	assert.match(b, /link to the main board is that board's own USB\*\* .*\/dev\/ttyACM0/)
	assert.match(b, /carries no link pins/)
	assert.doesNotMatch(b, /UART0/)
	assert.match(b, /motor driver and real-time control stay on the robot's main board/)
})

test("the UART0 alternative puts TX and RX on pins 8 and 10, with the Pi 5 debug-output warning", () => {
	const b = carrierBrief(pi, { board: "brain", bridge: "uart", mcuBoard: "base" })
	assert.match(b, /link to the base board is UART0 on the header\*\*: pin 8 \(the Raspberry Pi 5's TX\) and pin 10 \(its RX\)/)
	assert.match(b, /\/dev\/ttyAMA0/)
	assert.match(b, /kernel debug output to GPIO 14 and 15/)
	assert.match(b, /from the robot's battery into|from the robot's battery, into/)
})

test("addCarrier inserts { name: rpi-5-carrier, brief, carries } after the Pi, stacked under it in the assembly", () => {
	const base: SystemSpec = { name: "rover with a pi", boards: [{ name: "main", brief: "m.md" }, { name: "brain", kind: "bought", module: "rpi-5" }, { name: "climate", brief: "c.md" }], links: [] }
	const spec = { ...base, assembly: defaultAssembly(base, "chassis") }
	const r = addCarrier(spec, "brain", pi, { battery: pack })
	assert.equal(r.name, "rpi-5-carrier")
	assert.equal(r.briefPath, "briefs/rpi-5-carrier.md")
	assert.deepEqual(r.spec.boards.map((b) => b.name), ["main", "brain", "rpi-5-carrier", "climate"])
	assert.deepEqual(r.spec.boards[2], { name: "rpi-5-carrier", brief: "briefs/rpi-5-carrier.md", carries: "brain" })
	assert.match(r.brief, /5 A at 5\.1 V/)
	const brain = r.spec.assembly!.boards.find((b) => b.name === "brain")!, carrier = r.spec.assembly!.boards.find((b) => b.name === "rpi-5-carrier")!
	assert.deepEqual([carrier.xMm, carrier.yMm, carrier.outline, carrier.carries], [brain.xMm, brain.yMm, { widthMm: 85, heightMm: 56 }, "brain"])
	assert.deepEqual(specErrors(r.spec), [])
	assert.deepEqual(assemblyErrors(r.spec), [])
	assert.throws(() => addCarrier(r.spec, "brain", pi), /already has a carrier/)
	assert.throws(() => addCarrier(r.spec, "main", pi), /not a bought board/)
})
