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
	const onRail = (ref: string) => ["VSERVO1", "VSERVO2", "VSERVO3"].filter((r) => n.get(r)?.includes(`${ref}.V5`))
	for (let i = 1; i <= 6; i++) assert.equal(onRail(`JV${i}`).length, 1, `JV${i}`)
	assert.equal(n.get("SERVO_5V"), undefined)
})

test("arm board: each rail's TPS54560 from the brick jack, wired and supported from its catalog entry (chip-support.ts)", async () => {
	const { generatedNets, supportParts, powerTree } = await import("../src/codegen/circuit.ts")
	const { armRails } = await import("../src/contract/arm-rails.ts")
	const s = armBoard()
	const n = generatedNets(s)
	const rails = armRails(s)!
	assert.deepEqual(rails.map((r) => r.supplyRef), ["U7", "U8", "U10"])
	// Its entry's nets: VIN on the brick, SW on its own switch node, both grounds; EN open (its pull-up enables it).
	for (const u of ["U7", "U8", "U10"]) {
		assert.ok(n.get("VIN_BRICK")!.includes(`${u}.VIN`), u)
		assert.deepEqual([n.get(`${u}_SW`)?.includes(`${u}.SW`), n.get("GND")!.includes(`${u}.GND_2`)], [true, true], u)
		assert.ok(![...n.values()].some((e) => e.includes(`${u}.EN`)), `${u}.EN open`)
	}
	assert.ok(n.get("VIN_BRICK")!.includes("J10.VIN"))
	assert.equal(n.get("VIN_BRICK")!.length, new Set(n.get("VIN_BRICK")).size, "each pin once")
	assert.equal(powerTree(s)?.buck?.ref, "U9")
	assert.ok(n.get("VIN_BRICK")!.includes("U9.VIN"), "the logic's buck from the jack")
	const sp = supportParts(s)
	const of = (u: string) => sp.filter((x) => x.near === u)
	for (const [u, rail] of [["U7", "VSERVO1"], ["U8", "VSERVO2"], ["U10", "VSERVO3"]] as const) {
		const parts = of(u)
		// The divider from the rail to FB: 33k/5.1k (5.98 V) of JLCPCB's basic resistors.
		const top = parts.find((x) => x.spec.kind === "resistor" && "net" in x.a && x.a.net === rail)!
		assert.deepEqual([top.spec.value, top.b], ["33k", { ref: u, pin: "FB" }], u)
		// The catch Schottky from the switch node to ground (pad 1 the cathode), the inductor on to the rail.
		const d = parts.find((x) => x.spec.mpn === "SS56(SMB)")!
		assert.deepEqual([d.a, d.b], [{ net: `${u}_SW` }, { net: "GND" }])
		assert.deepEqual([parts.find((x) => x.spec.kind === "inductor")!.b], [{ net: rail }])
		assert.equal(parts.find((x) => x.job.includes("RT resistor"))!.spec.value, "200k")
		assert.equal(parts.filter((x) => x.job.includes("output capacitor")).length, 5)
	}
	const ceramics = sp.filter((x) => x.spec.kind === "capacitor" && "net" in x.a && x.a.net === "VIN_BRICK" && x.spec.value === "10uF")
	assert.equal(ceramics.length, 7) // two per TPS54560, one for the AP63205
	for (const c of ceramics) assert.equal(c.spec.mpn, "CL31A106KBHNNNE")
})

test("arm board input protection: SMBJ20A cathode on the brick net, 100 uF electrolytic + on it, both beside the jack", async () => {
	const { supportParts, generatedNets } = await import("../src/codegen/circuit.ts")
	const s = armBoard()
	const sp = supportParts(s)
	const tvs = sp.find((x) => x.spec.mpn === "SMBJ22A")!
	const elec = sp.find((x) => x.spec.mpn === "EEEFK1V101P")!
	for (const x of [tvs, elec]) {
		assert.deepEqual([x.a, x.b, x.near], [{ net: "VIN_BRICK" }, { net: "GND" }, "J10"])
		assert.deepEqual(x.pins, ["pin1", "pin2"]) // pad 1: the TVS's cathode band, the electrolytic's +
	}
	assert.ok(generatedNets(s).get("VIN_BRICK")!.includes(`${tvs.ref}.pin1`))
})

test("hot-plug check: the brick at its maximum picks the TVS; the clamp at the estimated surge is held against the rail chip", async () => {
	const { armInrush, HOTPLUG_SURGE_A } = await import("../src/arm/inrush.ts")
	const { armInputTvs, tvsClampAt, brickMaxV } = await import("../src/arm/tvs.ts")
	const s = armBoard()
	// 19.5 V ±5 % (an estimate when the brick gives none) reaches 20.48 V: over the SMBJ20A's 20 V, so the SMBJ22A.
	assert.equal(brickMaxV(19.5), 20.48)
	assert.equal(armInputTvs(s.values.arm.input)?.mpn, "SMBJ22A")
	const r = armInrush(s)
	// Its clamp at 5 A (linear model): 26.9 + (35.5 - 26.9) x 5 / 16.9 = 29.44 V, over the SY8368A's 28 V.
	assert.ok(Math.abs(tvsClampAt(armInputTvs(s.values.arm.input)!, HOTPLUG_SURGE_A) - 29.44) < 0.01)
	assert.equal(r.figure?.value, "29.44 V (TVS rated clamp 35.5 V)")
	// One rule for every chip on the input (lead-2, 26 Nov 2026): rated over the TVS's clamp at its full pulse, 35.5 V.
	// The rail chips the rule picked clear it (TPS54560, 65 V); the logic's AP63205 (32 V) does not, so the check flags it
	// until a 36 V+ logic step-down replaces it (the SY8368A's 28 V failed even the estimate).
	assert.equal(r.figure?.ok, false)
	assert.match(r.figure?.limit ?? "", /at most 32 V \(U9 AP63205WU-7\)/)
	assert.equal(r.violations.length, 1)
	assert.match(r.violations[0].message, /U9 AP63205WU-7 on the VIN_BRICK input is rated 32 V, under SMBJ22A's clamp of 35.5 V/)
	// A 20 V brick at ±5 % (GST120A20): 21 V, still the SMBJ22A; a 24 V brick has no TVS that stays off.
	s.values.arm.input = { ...s.values.arm.input, volts: 20, tolerancePct: 5 }
	assert.equal(armInputTvs(s.values.arm.input)?.mpn, "SMBJ22A")
	s.values.arm.input = { ...s.values.arm.input, volts: 24 }
	assert.match(armInrush(s).violations[0]?.message ?? "", /over every input TVS's stand-off/)
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
	const { supportParts } = await import("../src/codegen/circuit.ts")
	const bst = supportParts(s).find((x) => "ref" in x.a && x.a.ref === "U9" && x.a.pin === "BST")!.ref
	const u9 = pl.find((b) => b.ref === "U9")!, c26 = pl.find((b) => b.ref === bst)!
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
