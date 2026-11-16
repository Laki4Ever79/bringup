// The pull-cord start (mechanics.safety.start, match.h in the rover firmware; Eurobot General Rules 1.2 F.6, H.3): its
// plug and pin on the board, the checks that ask for them, and the firmware header that sets the match.
import { test } from "node:test"
import assert from "node:assert/strict"
import { defaultCheckCatalog, mechanicsChecksWith } from "../src/mechanics/checks.ts"
import { roverHeader, unassignedRoverPins } from "../src/mechanics/firmware.ts"
import { supportParts } from "../src/codegen/circuit.ts"
import { mechanicsShapeError } from "../src/mechanics/shape.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const PLUG = { ref: "JS1", role: "start", mpn: "PZ254V-11-02P", lcsc: "C492401", footprint: "pinrow2", pins: ["START", "GND"] }
function rover(edit: (v: Any) => void = () => {}, pin = true): ContractSnapshot {
	const v = JSON.parse(JSON.stringify(ROVER_BOARD))
	v.parts.push({ ...PLUG })
	if (pin) {
		const used = new Set(v.pins.map((p: Any) => p.gpio))
		v.pins.push({ signal: "START", gpio: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].find((g) => !used.has(g)), partRef: "JS1", partPin: "START" })
	}
	v.mechanics.safety = { start: { connector: "JS1", cordMm: 600, matchS: 100 } }
	edit(v)
	return { revision: 1, versions: {} as never, values: v }
}
const safety = (s: ContractSnapshot) => mechanicsChecksWith(s, defaultCheckCatalog()!).filter((x) => x.kind === "mech-safety")

test("a rover with its start plug and START on a GPIO passes, and its firmware gets the pin and the 100 s match", () => {
	assert.deepEqual(mechanicsChecksWith(rover(), defaultCheckCatalog()!), [])
	const h = roverHeader(rover())
	assert.match(h, /#define PIN_START \d+/)
	assert.match(h, /#define MATCH_MS 100000UL/)
	assert.doesNotMatch(roverHeader(rover((v) => delete v.mechanics.safety.start.matchS)), /MATCH_MS/)
})

test("START is pulled up on the board, so a pulled cord reads high", () => {
	const jobs = supportParts(rover()).filter((j) => /START pull-up/.test(j.job))
	assert.equal(jobs.length, 1)
	assert.deepEqual(jobs[0].a, { net: "START" })
	assert.equal(supportParts({ revision: 1, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) }).filter((j) => /START/.test(j.job)).length, 0)
})

test("a missing plug goes to the parts agent, a START with no GPIO to the architect", () => {
	const noPlug = safety(rover((v) => (v.parts = v.parts.filter((p: Any) => p.ref !== "JS1"))))
	assert.deepEqual(noPlug.map((x) => x.affects), [["parts"]])
	assert.match(noPlug[0].message, /PZ254V-11-02P/)
	const noPin = safety(rover(() => {}, false))
	assert.deepEqual(noPin.map((x) => x.affects), [["architect"]])
	assert.deepEqual(noPin[0].fields, ["pins"])
	assert.ok(unassignedRoverPins(rover(() => {}, false)).includes("START"))
	assert.ok(!unassignedRoverPins({ revision: 1, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) }).includes("START"))
})

test("the contract takes mechanics.safety.start only in its shape", () => {
	assert.equal(mechanicsShapeError(rover().values.mechanics), null)
	assert.match(mechanicsShapeError({ ...rover().values.mechanics, safety: { start: { connector: "JS1" } } }) ?? "", /mechanics\.safety must be/)
})

test("the pull-cord module is cited and used by a design with its plug", async () => {
	const { loadModules, moduleProblems, modulesUsed } = await import("../src/modules/library.ts")
	const { loadMechCatalog } = await import("../src/mechanics/catalog.ts")
	const { loadCatalog } = await import("../src/tools/parts-search.ts")
	const root = new URL("..", import.meta.url).pathname
	const m = loadModules(root).find((x) => x.id === "start-pullcord")!
	assert.deepEqual(moduleProblems(m, loadMechCatalog(root), new Set(loadCatalog(root).map((p) => p.mpn))), [])
	assert.equal(modulesUsed([m], rover().values).length, 1)
})
