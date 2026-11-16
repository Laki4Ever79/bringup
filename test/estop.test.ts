// The emergency stop (src/mechanics/safety.ts, catalog/mechanics.json safety): its NC contact in the motors' supply on
// the board, and the checks on its rating, plug and mount (Eurobot General Rules 1.2 F.4.c).
import { test } from "node:test"
import assert from "node:assert/strict"
import { defaultCheckCatalog, mechanicsChecksWith, mechanicsFigures } from "../src/mechanics/checks.ts"
import { generatedNets, netTraceWidths, supplyWidths, MOTOR_VM_NET } from "../src/codegen/circuit.ts"
import { mechanicsShapeError } from "../src/mechanics/shape.ts"
import { estopTopMm } from "../src/mechanics/safety.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const ESTOP = "OMRON A22E-M-01"
const PLUG = { ref: "JE1", role: "estop", mpn: "B2B-XH-A(LF)(SN)", lcsc: "C158012", footprint: "pinrow2_p2.5_id1_od1.8", pins: ["VBAT", "VM"] }

// The reference rover with an e-stop on a deck 125 mm up (its body clears the board) (its 54.7 mm body clears the plate) and its plug on the board.
function rover(edit: (v: Any) => void = () => {}): ContractSnapshot {
	const values = JSON.parse(JSON.stringify(ROVER_BOARD))
	values.parts.push({ ...PLUG })
	values.mechanics.safety = { estop: { part: ESTOP, at: { xMm: 20, yMm: 0, zMm: 125 }, connector: "JE1" } }
	edit(values)
	return { revision: 1, versions: {} as never, values }
}
const safety = (c: ContractSnapshot) => mechanicsChecksWith(c, defaultCheckCatalog()!).filter((v) => v.kind === "mech-safety")

test("the catalog's e-stop has every number cited, from Omron's datasheet", () => {
	const b = defaultCheckCatalog()!.mech.safety!.find((p) => p.mpn.startsWith(ESTOP))!
	assert.equal(b.colour, "red")
	assert.equal(b.contacts, "NC")
	assert.ok(b.headMm >= 20, "Eurobot F.4.c: at least 20 mm across")
	for (const [k, v] of Object.entries(b)) if (typeof v === "number") assert.ok(b.source[k]?.url && b.source[k]?.where, `${k} is cited`)
})

test("on the board the e-stop's contact sits between the cell and the driver's VM", () => {
	const s = rover()
	const nets = generatedNets(s)
	assert.ok(nets.get("VBAT")!.includes("JE1.VBAT"))
	assert.deepEqual(nets.get(MOTOR_VM_NET)!.filter((e) => !/^C\d/.test(e)).sort(), ["JE1.VM", "U5.VM"])
	assert.ok(!nets.get("VBAT")!.includes("U5.VM"), "the driver no longer sits on the cell directly")
	assert.ok(nets.get(MOTOR_VM_NET)!.some((e) => /^C\d/.test(e)), "the driver's VM capacitors follow it onto MOTOR_VM")
	// The motors' supply carries the cell's current: as wide as VBAT.
	assert.equal(supplyWidths(s).get(MOTOR_VM_NET), supplyWidths(s).get("VBAT"))
	assert.equal(netTraceWidths(s).get(MOTOR_VM_NET) ?? null, netTraceWidths(s).get("VBAT") ?? null)
})

test("without an e-stop the driver stays on VBAT, as before", () => {
	const values = JSON.parse(JSON.stringify(ROVER_BOARD))
	const nets = generatedNets({ revision: 1, versions: {} as never, values })
	assert.ok(nets.get("VBAT")!.includes("U5.VM"))
	assert.equal(nets.has(MOTOR_VM_NET), false)
})

test("the reference rover with an e-stop passes: its motors stall at 0.94 A, under the button's 1.5 A DC13", () => {
	assert.deepEqual(safety(rover()), [])
	const fig = mechanicsFigures(rover()).find((f) => f.check === "E-stop breaking current")!
	assert.ok(fig.ok)
	assert.match(fig.limit, /1\.5 A/)
	assert.equal(estopTopMm(rover().values.mechanics!, defaultCheckCatalog()!.mech), 157)
})

test("motors that draw more than the contact can break are named", () => {
	const s = rover()
	const cat = JSON.parse(JSON.stringify(defaultCheckCatalog()!))
	for (const m of cat.mech.motors) m.stallA = 2
	const v = mechanicsChecksWith(s, cat).filter((x) => x.kind === "mech-safety")
	assert.equal(v.length, 1)
	assert.match(v[0].message, /breaks at most 1\.5 A/)
})

test("a deck too low for the button's body, a missing plug and an unknown button are each named", () => {
	assert.match(safety(rover((v) => (v.mechanics.safety.estop.at.zMm = 70)))[0].message, /raise mechanics\.safety\.estop\.at\.zMm to at least 111 mm/)
	const noPlug = safety(rover((v) => (v.parts = v.parts.filter((p: Any) => p.ref !== "JE1"))))
	assert.equal(noPlug.length, 1)
	assert.deepEqual(noPlug[0].affects, ["parts"])
	assert.match(noPlug[0].message, /B2B-XH-A/)
	assert.match(safety(rover((v) => (v.mechanics.safety.estop.part = "SOME-BUTTON")))[0].message, /not in catalog\/mechanics\.json safety/)
	assert.ok(safety(rover((v) => (v.mechanics.safety.estop.at.xMm = 70))).some((x) => /overhangs/.test(x.message)))
})

test("the contract accepts mechanics.safety only in its shape", () => {
	assert.equal(mechanicsShapeError(rover().values.mechanics), null)
	assert.match(mechanicsShapeError({ ...rover().values.mechanics, safety: { estop: { part: ESTOP } } }) ?? "", /mechanics\.safety must be/)
})

test("the button's mass counts, high up: the rover gets heavier", () => {
	const mass = (s: ContractSnapshot) => Number(mechanicsFigures(s).find((f) => f.check === "Mass")!.value.split(" ")[0])
	const without = mass({ revision: 1, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) })
	assert.ok(Math.abs(mass(rover()) - without - 56) <= 1)
})

test("the e-stop module is cited, and a design with the button and its plug uses it", async () => {
	const { loadModules, moduleProblems, modulesUsed } = await import("../src/modules/library.ts")
	const { loadMechCatalog } = await import("../src/mechanics/catalog.ts")
	const { loadCatalog } = await import("../src/tools/parts-search.ts")
	const root = new URL("..", import.meta.url).pathname
	const m = loadModules(root).find((x) => x.id === "safety-estop-a22e")!
	assert.deepEqual(moduleProblems(m, loadMechCatalog(root), new Set(loadCatalog(root).map((p) => p.mpn))), [])
	assert.ok(modulesUsed([m], rover().values).length === 1)
	assert.equal(modulesUsed([m], { ...ROVER_BOARD } as Any).length, 0)
})

// Found by a board build on 16 Nov: the 56 g button high up behind the middle put 47 % of the weight on the caster.
test("the button's place counts in the climb check: behind the middle the caster carries too much", () => {
	assert.deepEqual(mechanicsChecksWith(rover(), defaultCheckCatalog()!), [])
	const back = rover((v) => (v.mechanics.safety.estop.at.xMm = -20))
	assert.deepEqual(mechanicsChecksWith(back, defaultCheckCatalog()!).map((x) => x.kind), ["mech-climb"])
})

// Found placing the Eurobot starter's button (16 Nov): on a deck at 120 mm its 34 mm body came down onto the main board.
test("the button's body may not come down onto a board under it", () => {
	const low = safety(rover((v) => (v.mechanics.safety.estop.at.zMm = 120)))
	assert.equal(low.length, 1)
	assert.match(low[0].message, /comes down onto board main .* at least 122 mm/)
	// Clear of the board (to one side of it, still over the plate), the same deck is fine.
	assert.deepEqual(safety(rover((v) => Object.assign(v.mechanics.safety.estop.at, { zMm: 120, xMm: 52 }))), [])
})
