// The Eurobot rule check (rules/eurobot.ts, catalog/rules/eurobot-2026.json): every limit cited to the official
// General Rules 1.2, each finding naming its clause, and what isn't modelled listed as not checked.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { defaultCheckCatalog, mechanicsChecksWith, mechanicsFigures } from "../src/mechanics/checks.ts"
import { motionBriefChecks, motionFromBrief } from "../src/mechanics/brief.ts"
import { mechanicsSection } from "../src/mechanics/report.ts"
import { motionShapeError } from "../src/mechanics/shape.ts"
import { hullPerimeterMm } from "../src/rules/eurobot.ts"
import { EUROBOT_BOARD, ROVER_BOARD } from "../src/inference/scripts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const ROOT = new URL("..", import.meta.url).pathname
const snap = (v: unknown): ContractSnapshot => ({ revision: 1, versions: {} as never, values: v as never })
// The scripted Eurobot base (EUROBOT_BOARD: sized to carry the beacon), with or without its e-stop and pull-cord start.
function rover(safe = true, edit: (v: Any) => void = () => {}): ContractSnapshot {
	const v = JSON.parse(JSON.stringify(EUROBOT_BOARD))
	if (!safe) {
		v.parts = v.parts.filter((p: Any) => p.ref !== "JS1" && p.ref !== "JE1")
		v.pins = v.pins.filter((p: Any) => p.signal !== "START")
		delete v.mechanics.safety
	}
	edit(v)
	return snap(v)
}
const rules = (s: ContractSnapshot) => mechanicsChecksWith(s, defaultCheckCatalog()!).filter((x) => x.kind === "mech-rules").map((x) => x.message)

test("every limit in the rule set cites its clause and page in the official rules", () => {
	const r = JSON.parse(readFileSync(`${ROOT}catalog/rules/eurobot-2026.json`, "utf8"))
	assert.match(r.document.url, /eurobot\.org\/.*General_Rules_1\.2_EN\.pdf$/)
	for (const [k, l] of Object.entries(r.limits) as [string, Any][]) assert.match(l.source.where, /^[FH]\.\d.*p\. \d+/, `${k} names its clause and page`)
	assert.equal(r.limits.startPerimeterMm.value, 1200)
	assert.equal(r.limits.heightMm.value, 350)
	assert.equal(r.limits.cordMinMm.value, 500)
	assert.equal(r.limits.matchS.value, 100)
})

test("the reference rover without safety parts fails the rules on its e-stop and its start; with them it passes", () => {
	const before = rules(rover(false))
	assert.equal(before.length, 2)
	assert.match(before[0], /^F\.4\.c.*red emergency stop button at least 20 mm/)
	assert.match(before[1], /^F\.6.*only a pull-cord start/)
	assert.deepEqual(mechanicsChecksWith(rover(), defaultCheckCatalog()!), [])
	const figs = mechanicsFigures(rover()).filter((f) => f.check.startsWith("eurobot-2026"))
	assert.equal(figs.length, 11)
	assert.ok(figs.every((f) => f.ok && f.sources?.[0].url.includes("eurobot.org")))
})

test("the button's head is 32 mm proud of its deck: without a collar it stands too far over the robot", () => {
	const v = rules(rover(true, (x) => delete x.mechanics.safety.estop.collarMm))
	assert.equal(v.length, 1)
	assert.match(v[0], /more than the 25 mm.*collarMm to at least 7/)
	assert.ok(rules(rover(true, (x) => (x.mechanics.safety.estop.at.zMm = 350))).some((m) => /over the 375 mm/.test(m)))
})

test("a short cord, no match stop, too high a voltage and too big an outline are each named by clause", () => {
	assert.match(rules(rover(true, (x) => (x.mechanics.safety.start.cordMm = 300)))[0], /^F\.6.*at least 500 mm/)
	assert.match(rules(rover(true, (x) => delete x.mechanics.safety.start.matchS))[0], /^H\.2.*never stops the robot/)
	const cat = JSON.parse(JSON.stringify(defaultCheckCatalog()!))
	const pack = cat.mech.batteries.find((b: Any) => b.mpn === EUROBOT_BOARD.mechanics.battery.pack)
	pack.fullV = 50
	assert.ok(mechanicsChecksWith(rover(), cat).some((x) => x.kind === "mech-rules" && /^F\.4\.b.*48 V/.test(x.message)))
	assert.ok(hullPerimeterMm([{ what: "plate", xMm: 0, yMm: 0, zMm: 0, sizeMm: [300, 300, 3], massG: 0 }]) === 1200)
	const big = mechanicsFigures(rover(true, (x) => { x.mechanics.chassis.plateMm = [320, 300] })).find((f) => f.check === "eurobot-2026: Start perimeter")!
	assert.equal(big.ok, false)
})

test("a brief that names Eurobot asks the architect for motion.rules; the contract takes only known rule sets", () => {
	const brief = readFileSync(`${ROOT}briefs/eurobot-base.md`, "utf8")
	assert.equal(motionFromBrief(brief).rules, "eurobot-2026")
	const plain = JSON.parse(JSON.stringify(ROVER_BOARD))
	const v = motionBriefChecks(snap(plain), "A rover for Eurobot.")
	assert.equal(v.length, 1)
	assert.match(v[0].message, /motion\.rules: "eurobot-2026"/)
	assert.deepEqual(v[0].affects, ["architect"])
	assert.equal(motionShapeError(rover().values.motion), null)
	assert.match(motionShapeError({ ...rover().values.motion, rules: "robocup" }) ?? "", /motion\.rules is one of: eurobot-2026/)
})

test("the report lists what isn't checked against the rules, never as passed", () => {
	const text = mechanicsSection(rover(), undefined).join("\n")
	assert.match(text, /Not checked against Eurobot General Rules[^\n]*\n(- [^\n]*\n)*- F\.6 beacon support: solid and opaque/)
	assert.match(text, /eurobot-2026: Start perimeter \| \d+ mm \| 1200 mm \(F\.3 Dimensions\) \| ok/)
	assert.doesNotMatch(mechanicsSection(snap(JSON.parse(JSON.stringify(ROVER_BOARD))), undefined).join("\n"), /Not checked against/)
})

test("the rules module is cited and counts as used only by a design entered for Eurobot", async () => {
	const { loadModules, moduleProblems, modulesUsed } = await import("../src/modules/library.ts")
	const { loadMechCatalog } = await import("../src/mechanics/catalog.ts")
	const m = loadModules(ROOT).find((x) => x.id === "rules-eurobot-2026")!
	assert.deepEqual(moduleProblems(m, loadMechCatalog(ROOT), new Set(), ROOT), [])
	assert.equal(modulesUsed([m], rover().values).length, 1)
	assert.equal(modulesUsed([m], JSON.parse(JSON.stringify(ROVER_BOARD))).length, 0)
})
