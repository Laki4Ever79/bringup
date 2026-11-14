// A rover's distance sensor (a plug-in breakout from catalog/mechanics.json, not a part in parts.json) sits on the
// board's one I2C bus too: the link checks must count it like any sensor soldered on the board.
import { test } from "node:test"
import assert from "node:assert/strict"
import { systemChecks } from "../src/system/checks.ts"
import { boardLinks } from "../src/system/derive.ts"
import type { SystemSpec } from "../src/system/spec.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import type { Mechanics } from "../src/mechanics/types.ts"
import { fixtureContract } from "./fixture.ts"

const SENSOR = "ADAFRUIT-3317 VL53L0X breakout (STEMMA QT)"
const spec = (targets: Record<string, number>, controller: string): SystemSpec => ({
	name: "rover and a beacon",
	boards: [{ name: "rover", brief: "r.md" }, { name: "beacon", brief: "b.md" }],
	links: [{ id: "L1", kind: "i2c", a: { board: "rover" }, b: { board: "beacon" }, i2c: { controller, targets, pullupsOn: controller }, cable: { lengthMm: 150 } }],
})
// A board with no I2C part in its parts list; the rover also carries the distance sensor on a cable.
function board(s: SystemSpec, name: string, rover: boolean): ContractSnapshot {
	const c = fixtureContract()
	c.values.parts = (c.values.parts ?? []).filter((p) => p.role !== "sensor")
	c.values.links = boardLinks(s, name)
	if (rover) c.values.mechanics = { sensor: { module: SENSOR, at: { xMm: 70, yMm: 0, zMm: 20 }, connector: "J3" } } as unknown as Mechanics
	return c
}

test("a rover as the I2C target is flagged: its one controller already drives the distance sensor", () => {
	const s = spec({ rover: 0x42 }, "beacon")
	const f = systemChecks(s, { rover: board(s, "rover", true), beacon: board(s, "beacon", false) })
	assert.ok(f.some((x) => x.kind === "i2c-target-has-bus" && x.boards.includes("rover") && /VL53L0X/.test(x.message)), JSON.stringify(f))
})

test("a target at the distance sensor's address (0x29) clashes on the rover's bus", () => {
	const s = spec({ beacon: 0x29 }, "rover")
	const f = systemChecks(s, { rover: board(s, "rover", true), beacon: board(s, "beacon", false) })
	assert.ok(f.some((x) => x.kind === "i2c-address" && /0x29/.test(x.message)), JSON.stringify(f))
	const ok = spec({ beacon: 0x42 }, "rover")
	assert.deepEqual(systemChecks(ok, { rover: board(ok, "rover", true), beacon: board(ok, "beacon", false) }).filter((x) => x.kind.startsWith("i2c")), [])
})
