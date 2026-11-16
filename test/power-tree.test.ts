// A robot's pack with no charger on the board still runs the 3V3 rail (src/codegen/circuit.ts powerTree): real run 16
// (Eurobot, 16 Nov 2026) hung its LDO on VBUS alone, so on battery the MCU, encoders and sensor were off.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { generatedNets, ldoInputNet, powerTree } from "../src/codegen/circuit.ts"
import { supplyWiring } from "../src/contract/consistency.ts"
import { defaultCheckCatalog } from "../src/mechanics/checks.ts"

const load = () => JSON.parse(readFileSync(new URL("./fixtures/cc-eurobot-16-rev23.json", import.meta.url), "utf8"))
const cat = defaultCheckCatalog()!
const part = (role: string, ref: string) => ({ ...(cat.boardParts as unknown as { role: string }[]).find((p) => p.role === role)!, ref })
const kinds = (s: unknown) => supplyWiring(s as never).filter((v) => v.kind.startsWith("rail-")).map((v) => v.kind)
const shorts = (s: unknown) => {
	const on = new Map<string, number>()
	for (const ends of generatedNets(s as never).values()) for (const e of new Set(ends)) on.set(e, (on.get(e) ?? 0) + 1)
	return [...on].filter(([, n]) => n > 1).map(([e]) => e)
}

test("run 16 (1S cell, no charger): refused, naming an ideal diode for the cell and a Schottky for VBUS", () => {
	const s = load()
	assert.equal(ldoInputNet(s), "VBUS")
	const v = supplyWiring(s).find((x) => x.kind === "rail-battery-source")
	assert.match(v?.message ?? "", /an ideal diode for the cell \(role ideal-diode, catalog LM66100DCKR/)
	assert.match(v?.message ?? "", /a Schottky diode for VBUS \(role diode, catalog B5819W SL/)
})

test("with them, the cell feeds 3V3 through the ideal diode and USB through the Schottky; nothing shorts", () => {
	const s = load()
	s.values.parts.push(part("ideal-diode", "U8"), part("diode", "D10"))
	assert.ok(powerTree(s))
	assert.equal(ldoInputNet(s), "VIN_OR")
	const n = generatedNets(s)
	assert.ok(n.get("VBAT")!.includes("U8.VIN"))
	for (const e of ["U8.VOUT", "U8.CE", "D10.K", "U3.VIN"]) assert.ok(n.get("VIN_OR")!.includes(e), e)
	assert.ok(n.get("VBUS")!.includes("D10.A") && !n.get("VBUS")!.includes("U3.VIN"))
	assert.ok(n.get("GND")!.includes("U8.ST"))
	assert.deepEqual(shorts(s), [])
	assert.deepEqual(kinds(s), [])
})

test("a 2S pack (over the LDO's 5.5 V): a 5 V step-down and two Schottkys; with them, clean", () => {
	const s = load()
	s.values.mechanics.battery.pack = "GENSACE-GEA22002S20X6 2S 2200 mAh 20C LiPo XT60"
	assert.match(supplyWiring(s).find((x) => x.kind === "rail-battery-source")?.message ?? "", /a 5 V step-down \(role buck, catalog POLOLU-2843 D24V5F5.*2 Schottky diodes/)
	s.values.parts.push(part("buck", "U7"), part("diode", "D10"), part("diode", "D11"))
	const n = generatedNets(s)
	assert.ok(n.get("VBAT")!.includes("U7.VIN") && n.get("V5")!.includes("U7.VOUT") && n.get("V5")!.includes("D10.A"))
	assert.ok(n.get("VIN_OR")!.includes("D10.K") && n.get("VIN_OR")!.includes("D11.K") && n.get("VBUS")!.includes("D11.A"))
	assert.deepEqual(shorts(s), [])
	assert.deepEqual(kinds(s), [])
})

test("a 1S cell through a Schottky is refused for headroom; with a charger on the board nothing applies", () => {
	const s = load()
	s.values.parts.push(part("diode", "D10"), part("diode", "D11"))
	assert.deepEqual(kinds(s), ["rail-headroom"])
	const c = load()
	c.values.parts.push({ ...(cat.boardParts as unknown as { role: string }[]).find((p) => p.role === "charger")!, ref: "U4" })
	assert.ok(!kinds(c).some((k) => k === "rail-battery-source" || k === "rail-headroom"))
})

// Real run 16: rails arrived at revision 23, and the board built at 22 without its 3V3 net stayed current.
test("the board is built from the rails and waits for them; the mechanics it reads are a narrow derived key", async () => {
	const { BUILD_INPUTS, BUILD_REQUIRES, BOARD_DERIVED } = await import("../src/agents/builders.ts")
	assert.ok(BUILD_INPUTS.board.includes("rails") && BUILD_REQUIRES.board.includes("rails"))
	const s = load()
	const k0 = JSON.stringify(BOARD_DERIVED(s))
	s.values.mechanics.chassis.plateMm = [280, 260]
	assert.equal(JSON.stringify(BOARD_DERIVED(s)), k0, "a chassis change alone doesn't rebuild the board")
	s.values.mechanics.sensor.connector = "JT9"
	assert.notEqual(JSON.stringify(BOARD_DERIVED(s)), k0, "the sensor plug's VCC does")
})

test("a design with supplied parts and no 3V3 rail is refused (run 16 rev 22)", () => {
	const s = load()
	delete s.values.rails
	assert.ok(supplyWiring(s).some((v) => v.kind === "rail-missing" && /U1/.test(v.message)))
})
