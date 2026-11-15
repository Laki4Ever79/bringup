import { test } from "node:test"
import assert from "node:assert/strict"
import { progressState, badgeOf, stepOfEvent } from "../src/dashboard/progress.js"

const L = (round: number, board: string, step: string, status: string, extra = {}) => ({ at: "t", round, board, step, status, ...extra }) as never

test("a replay gives the last step per board and the system's last line", () => {
	const s = progressState([L(0, "main", "board", "started"), L(0, "climate", "board", "ok", { revision: 2 }), L(0, "main", "board", "ok"), L(0, "main", "case", "started"), L(0, "system", "link", "ok", { detail: "i2c pass" })])
	assert.equal(s.boards.main.step, "case")
	assert.equal(s.boards.main.status, "started")
	assert.equal(s.boards.main.steps.board?.status, "ok")
	assert.equal(s.boards.climate.revision, 2)
	assert.deepEqual(s.system, { step: "link", status: "ok", detail: "i2c pass" })
})

test("a failed step keeps its detail, and the board's badge says so", () => {
	const s = progressState([L(0, "main", "firmware", "failed", { detail: "undefined pin" }), L(0, "main", "firmware", "started")])
	assert.equal(s.boards.main.steps.firmware?.status, "started")
	const f = progressState([L(0, "main", "firmware", "started"), L(0, "main", "firmware", "failed", { detail: "undefined pin" })])
	assert.equal(f.boards.main.steps.firmware?.detail, "undefined pin")
	assert.equal(badgeOf(f.boards.main)?.kind, "bad")
	assert.match(badgeOf(f.boards.main)!.title, /undefined pin/)
})

test("the round is the highest seen, and a new round greys the old chips instead of clearing them", () => {
	const s = progressState([L(0, "main", "board", "ok"), L(0, "main", "case", "failed", { detail: "wall too thin" }), L(1, "main", "request", "started"), L(1, "main", "case", "started")])
	assert.equal(s.round, 1)
	assert.deepEqual(Object.keys(s.boards.main.steps).sort(), ["board", "case", "request"])
	assert.equal(s.boards.main.steps.board?.prev, true, "last round's chip survives, greyed")
	assert.equal(s.boards.main.steps.case?.status, "started")
	assert.equal(s.boards.main.steps.case?.prev, undefined, "replaced by its new line")
	assert.equal(s.boards.main.steps.request?.prev, undefined)
})

test("a per-board request line greys that board's chips even within the same round", () => {
	const s = progressState([L(0, "main", "board", "ok"), L(0, "main", "request", "started")])
	assert.equal(s.boards.main.steps.board?.prev, true)
})

test("a system link failure stays visible until the next link line", () => {
	const s = progressState([L(0, "system", "link", "failed", { detail: "baud mismatch" }), L(0, "system", "assembly", "ok")])
	assert.equal(s.systemSteps.link?.detail, "baud mismatch")
	assert.equal(progressState([L(0, "system", "link", "failed"), L(0, "system", "link", "ok")]).systemSteps.link?.status, "ok")
})

test("stepOfEvent maps a board's own trace events like the system's stepOf", () => {
	assert.deepEqual(stepOfEvent({ type: "design.settled", payload: { settled: true, revision: 3 } }), { step: "settled", status: "ok", revision: 3 })
	assert.equal(stepOfEvent({ type: "agent.activity", payload: {} }), null)
	assert.equal(stepOfEvent({ type: "artifact.failed", payload: { kind: "firmware", revision: 1, error: "x\ny" } })?.status, "failed")
})

test("settled ok is a tick; nothing is no badge", () => {
	assert.equal(badgeOf(progressState([L(0, "main", "settled", "ok")]).boards.main)?.text, "✓")
	assert.equal(badgeOf(undefined), null)
	assert.deepEqual(progressState([]), { round: 0, boards: {}, system: { step: null, status: null }, systemSteps: {} })
})
