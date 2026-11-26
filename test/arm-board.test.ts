// Arm task 6 (board): the servo plugs and their figure. Review Focus 4 (lead decision, 25 Nov 2026): the PZ254V (3 A)
// carrying an MG996R at stall at the arm's 6 V rail (2.5 A, 3.1 A with CONNECTOR_HEADROOM) is a figure, not a violation,
// and the figure's note names the servo's own lead as the real limit.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { loadMechCatalog, servoAt } from "../src/mechanics/catalog.ts"
import { armPlugFigures, SERVO_LEAD_NOTE } from "../src/arm/plugs.ts"

const root = new URL("..", import.meta.url).pathname
const servos = loadMechCatalog(root).servos ?? []
const boardCat = JSON.parse(readFileSync(new URL("../catalog/parts.json", import.meta.url), "utf8")) as { mpn: string; ratedA?: number; source?: Record<string, { url: string; where: string }> }[]
const pz = boardCat.find((p) => p.mpn === "PZ254V-11-03P")!

test("MG996R plug: a figure, no violation, note names the lead", () => {
	const mg = servos.find((s) => s.mpn === "MG996R")!
	const at = servoAt(mg, 6)
	assert.ok(!("error" in at))
	assert.equal(at.stallA, 2.5)
	const { figures, violations } = armPlugFigures([{ ref: "JV2", plug: pz, servo: mg, railV: 6 }])
	assert.equal(figures.length, 1)
	assert.equal(figures[0].value, "2.5 A")
	assert.equal(figures[0].ok, false) // 3.1 A asked of a 3 A plug: under the headroom
	assert.ok(figures[0].note?.includes(SERVO_LEAD_NOTE))
	assert.ok(figures[0].sources?.some((x) => x.field === "ratedA") && figures[0].sources?.some((x) => x.field === "stallA" && x.mpn === "MG996R"))
	assert.deepEqual(violations, [])
})

test("a servo drawing more than the plug's plain rating is a violation", () => {
	const mg = servos.find((s) => s.mpn === "MG996R")!
	const { violations } = armPlugFigures([{ ref: "JV1", plug: { ...pz, ratedA: 2 }, servo: mg, railV: 6 }])
	assert.match(violations[0]?.message ?? "", /JV1 PZ254V-11-03P is rated 2 A but one MG996R at stall draws 2.5 A at 6 V/)
})

// A test arm board (test/fixtures/arm-board-test.json, built from run 21's Eurobot parts: the S3, PCA9685, AP63205, LDO
// and SY8368A, with six PZ254V plugs, a second SY8368A and the brick jack): what circuit.ts wires for values.arm.
const armBoard = () => JSON.parse(readFileSync(new URL("./fixtures/arm-board-test.json", import.meta.url), "utf8"))

test("arm board: 6 servo plugs on PCA9685 LED0..5", async () => {
	const { generatedNets } = await import("../src/codegen/circuit.ts")
	const s = armBoard()
	const n = generatedNets(s)
	const chans = [...s.values.arm.joints.map((j: { channel: number }) => j.channel), s.values.arm.gripper.channel]
	assert.deepEqual(chans, [0, 1, 2, 3, 4, 5])
	chans.forEach((ch: number, i: number) => assert.deepEqual(n.get(`SERVO_CH${ch}`), [`U6.LED${ch}`, `JV${i + 1}.SIG`]))
	// Every plug's +V on exactly one servo rail; no plug on the rover's 5 V servo net.
	const onRail = (ref: string) => ["VSERVO1", "VSERVO2"].filter((r) => n.get(r)?.includes(`${ref}.V5`))
	for (let i = 1; i <= 6; i++) assert.equal(onRail(`JV${i}`).length, 1, `JV${i}`)
	assert.equal(n.get("SERVO_5V"), undefined)
})

test("arm board: each rail's SY8368A from the brick jack, its 6.0 V divider (27k/3k), and 50 V input capacitors", async () => {
	const { generatedNets, supportParts, powerTree } = await import("../src/codegen/circuit.ts")
	const { armRails } = await import("../src/contract/arm-rails.ts")
	const s = armBoard()
	const n = generatedNets(s)
	const rails = armRails(s)!
	assert.deepEqual(rails.map((r) => r.supplyRef), ["U7", "U8"])
	for (const u of ["U7", "U8"]) for (const pin of ["IN", "IN_2", "IN_3", "EN"]) assert.ok(n.get("VIN_BRICK")!.includes(`${u}.${pin}`), `${u}.${pin}`)
	assert.ok(n.get("VIN_BRICK")!.includes("J10.VIN"))
	assert.equal(n.get("VIN_BRICK")!.length, new Set(n.get("VIN_BRICK")).size, "each pin once")
	assert.equal(powerTree(s)?.buck?.ref, "U9")
	assert.ok(n.get("VIN_BRICK")!.includes("U9.VIN"), "the logic's buck from the jack")
	const sp = supportParts(s)
	for (const rail of ["VSERVO1", "VSERVO2"]) assert.equal(sp.find((x) => x.spec.kind === "resistor" && "net" in x.a && x.a.net === rail)?.spec.value, "27k", rail)
	const ceramics = sp.filter((x) => x.spec.kind === "capacitor" && "net" in x.a && x.a.net === "VIN_BRICK" && x.spec.value === "10uF")
	assert.equal(ceramics.length, 5) // two per SY8368A, one for the AP63205
	for (const c of ceramics) assert.equal(c.spec.mpn, "CL31A106KBHNNNE")
})

test("arm board input protection: SMBJ20A cathode on the brick net, 100 uF electrolytic + on it, both beside the jack", async () => {
	const { supportParts, generatedNets } = await import("../src/codegen/circuit.ts")
	const s = armBoard()
	const sp = supportParts(s)
	const tvs = sp.find((x) => x.spec.mpn === "SMBJ20A")!
	const elec = sp.find((x) => x.spec.mpn === "EEEFK1V101P")!
	for (const x of [tvs, elec]) {
		assert.deepEqual([x.a, x.b, x.near], [{ net: "VIN_BRICK" }, { net: "GND" }, "J10"])
		assert.deepEqual(x.pins, ["pin1", "pin2"]) // pad 1: the TVS's cathode band, the electrolytic's +
	}
	assert.ok(generatedNets(s).get("VIN_BRICK")!.includes(`${tvs.ref}.pin1`))
})

test("hot-plug check: a 19.5 V brick peaks at 26.62 V under the SY8368A's 28 V; a 24 V brick is over the TVS's stand-off", async () => {
	const { armInrush, tvsClampV, HOTPLUG_SURGE_A } = await import("../src/arm/inrush.ts")
	const s = armBoard()
	const r = armInrush(s)
	assert.equal(r.figure?.value, "26.62 V")
	assert.equal(r.figure?.ok, true)
	assert.match(r.figure?.limit ?? "", /28 V \(U7 SY8368AQQC\)/)
	assert.match(r.figure?.note ?? "", /an estimate/)
	assert.deepEqual(r.violations, [])
	assert.ok(Math.abs(tvsClampV(HOTPLUG_SURGE_A) - 26.62) < 0.01)
	s.values.arm.input.volts = 24
	assert.match(armInrush(s).violations[0]?.message ?? "", /over the input TVS's 20 V stand-off/)
})

test("every two-pad land pattern (inductors, the electrolytic) fits inside the box the placer keeps for it", async () => {
	const { INDUCTOR_FOOTPRINTS, footprintBox } = await import("../src/codegen/circuit.ts")
	for (const [name, f] of Object.entries(INDUCTOR_FOOTPRINTS)) {
		const [w, h] = footprintBox(name)
		assert.ok(2 * f.cx + f.padW <= w + 1e-9, `${name}: pads span ${2 * f.cx + f.padW} mm, box ${w} mm`)
		assert.ok(f.padH <= h && f.body[0] <= w && f.body[1] <= h, name)
	}
})

test("a SOT-23's pads are known (tscircuit's own): the check always uses them; placement beside them is the fallback layout", async () => {
	const { sotPinOffset, layoutBoard, unreachableCaps } = await import("../src/codegen/circuit.ts")
	assert.deepEqual(sotPinOffset("sot23_6", 6), { x: 1.3, y: 0.95 })
	assert.deepEqual(sotPinOffset("sot23_5", 5), { x: 1.137, y: 0.95 })
	const s = JSON.parse(readFileSync(new URL("./fixtures/arm-board-test.json", import.meta.url), "utf8"))
	// The check always knows the pads: the default layout (pin parts at the chip) leaves U9's BST capacitor out of reach,
	// so the board build skips it for the layout with the SOT-23 pads (pinPads, tried after the others).
	assert.ok(unreachableCaps(s, {}).some((m) => /U9 > \.BST/.test(m)))
	const pl = layoutBoard(s, { pinPads: true }).parts
	const u9 = pl.find((b) => b.ref === "U9")!, c26 = pl.find((b) => b.ref === "C26")!
	// U9's BST (pin 6) to its capacitor: within the 5 mm bound (it was 14.56 mm when the pads were unknown).
	assert.ok(Math.hypot(u9.x + 1.3 - c26.x, u9.y + 0.95 - c26.y) < 5)
	assert.deepEqual(unreachableCaps(s, { pinPads: true }), [])
})

// KNOWN FAILURE (arm task 6, lead-2, 26 Nov 2026): the arm board's rails don't get their copper on 2 layers. Routed at
// the default track and widened after (option c): at 62×47 (placement minimum) DRC 0, VSERVO1 at its 2.8 mm on 10 of 94 mm,
// VSERVO2 at 2.5 mm on 21 of 100, VIN_BRICK at 1.8 mm on 17 of 155; at 71×54 (the rails' lanes counted, +32 % area)
// 0 unconnected, but 5/101, 5/78 and 53/169 mm: the router packs its tracks beside the rails at any size. With the widths
// as Freerouting classes (option b): 20 connections unrouted. Next: 4 layers (option a, its own task).
// Run: npm run board -- test/fixtures/arm-board-test.json
test("KNOWN FAILURE: the arm board routes clean with every rail at its width", { todo: "option (a), 4 layers: on 2 layers the rails reach their width on 5-31 % of their track" }, async () => {
	const { wideTracks } = await import("../src/codegen/circuit.ts")
	const s = JSON.parse(readFileSync(new URL("./fixtures/arm-board-test.json", import.meta.url), "utf8"))
	// What the build meets today: rails wider than a track reaching a pin, routed by Freerouting and widened after.
	assert.deepEqual(wideTracks(s).map(([n]) => n), ["VSERVO2", "VIN_BRICK"])
	assert.fail("on 2 layers the rails reach their width on 5-31 % of their track, at 62×47 and at 71×54")
})

test("the pin-pad layouts (pinPads) come after every plain one, so a board that routed before keeps its first layout", async () => {
	const { withPinPadLayouts, layoutAttempts } = await import("../src/tools/board.ts")
	const s = JSON.parse(readFileSync(new URL("./fixtures/arm-board-test.json", import.meta.url), "utf8"))
	const plain = layoutAttempts(s, [{}])
	const all = withPinPadLayouts(s, plain)
	assert.deepEqual(all.slice(0, plain.length), plain)
	assert.ok(all.length > plain.length && all.slice(plain.length).every((p) => p.pinPads))
})

test("on every layout the build tries, the debug footprint's holes stay clear of the top parts (C2 sat on them on a pin-pad layout)", async () => {
	const { layoutBoard, debugPort } = await import("../src/codegen/circuit.ts")
	const { layoutAttempts, withPinPadLayouts } = await import("../src/tools/board.ts")
	const s = JSON.parse(readFileSync(new URL("./fixtures/arm-board-test.json", import.meta.url), "utf8"))
	for (const o of withPinPadLayouts(s, layoutAttempts(s, [{}]))) {
		const dp = debugPort(s, o).placed
		if (!dp) continue
		for (const b of layoutBoard(s, o).parts)
			for (const h of dp.holes) assert.ok(Math.abs(h.x - b.x) > b.w / 2 || Math.abs(h.y - b.y) > b.h / 2, `${JSON.stringify(o)}: JD1 hole at ${h.x},${h.y} inside ${b.ref}`)
	}
})
