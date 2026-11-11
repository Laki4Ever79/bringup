// Editing a plan by dragging (src/dashboard/plan-edit.js): pure functions shared by the plan screen and the hub.
import { test } from "node:test"
import assert from "node:assert/strict"
import { addBoard, afterSave, connect, moveBoard, planDiff, removeBoard, removeLink, setBrief } from "../src/dashboard/plan-edit.js"
import { scriptedPlan } from "../src/system/architect.ts"
import { planChecks, type Plan } from "../src/system/plan.ts"

const two = (): Plan => ({ ...scriptedPlan("a logger and a beacon over a cable"), id: "p", version: 3, spendUsd: null })

test("moving a board changes only its drawing position", () => {
	const p = moveBoard(two(), "logger", 300, 40)
	assert.deepEqual(p.layout.logger, { x: 300, y: 40 })
	assert.deepEqual(planDiff(two(), p), { added: [], removed: [], changed: [] })
})

test("removing a board removes its cables too, and the plan stays valid", () => {
	const p = removeBoard(two(), "beacon")
	assert.deepEqual(p.spec.boards.map((b) => b.name), ["logger"])
	assert.equal(p.spec.links.length, 0)
	assert.equal(p.briefs.beacon, undefined)
	assert.deepEqual(planDiff(two(), p).removed, ["beacon", "L1"])
	assert.deepEqual(planChecks(p), [])
})

test("a new board gets a unique name and a brief; a new cable a unique id", () => {
	let p = addBoard(two(), "sensor", "# Brief: sensor\n")
	p = addBoard(p, "sensor", "# Brief: another\n")
	assert.deepEqual(p.spec.boards.map((b) => b.name), ["logger", "beacon", "sensor", "sensor-2"])
	assert.equal(p.spec.boards[2].brief, "briefs/sensor.md")
	p = connect(p, "logger", "sensor", "i2c")
	p = connect(p, "logger", "sensor-2", "i2c")
	assert.deepEqual(p.spec.links.map((l) => l.id), ["L1", "L2", "L3"])
	const [l2, l3] = p.spec.links.slice(1)
	assert.deepEqual(l2.i2c, { controller: "logger", targets: { sensor: 0x42 }, pullupsOn: "logger" })
	assert.equal(l3.i2c!.targets["sensor-2"], 0x43, "a second target on logger's bus gets the next free address")
	assert.deepEqual(planChecks(p), [])
	assert.deepEqual(planDiff(two(), p).added, ["sensor", "sensor-2", "L2", "L3"])
})

test("a UART cable gets the default speed and length; removing it leaves the boards", () => {
	let p = removeLink(two(), "L1")
	assert.equal(p.spec.links.length, 0)
	p = connect(p, "beacon", "logger", "uart")
	assert.deepEqual(p.spec.links[0], { id: "L1", kind: "uart", a: { board: "beacon" }, b: { board: "logger" }, baud: 115200, cable: { lengthMm: 200 } })
})

test("editing a brief marks the board changed", () => {
	const p = setBrief(two(), "beacon", "# Brief: a smaller beacon\n")
	assert.deepEqual(planDiff(two(), p).changed, ["beacon"])
})

// pending-fixes, 11 Nov: a second edit made while the first save was in flight was overwritten by the save's answer,
// and its own save then hit a stale version (409) and reloaded: the edit was lost both ways.
test("a save's answer keeps an edit made meanwhile, taking only the new version from the hub", () => {
	const sent = two()
	const saved = { ...sent, version: 4 }
	const meanwhile = moveBoard(sent, "logger", 300, 40)
	const kept = afterSave(meanwhile, saved, true)
	assert.deepEqual(kept.layout.logger, { x: 300, y: 40 })
	assert.equal(kept.version, 4)
	// With no edit meanwhile, the hub's answer is taken (it may have normalised the plan), keeping the drawing.
	const taken = afterSave(sent, { ...saved, why: "from the hub" }, false)
	assert.equal(taken.why, "from the hub")
	assert.deepEqual(taken.layout, sent.layout)
})
