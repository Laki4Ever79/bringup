import { test } from "node:test"
import assert from "node:assert/strict"
import { progressState, badgeOf } from "../src/dashboard/progress.js"

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

test("the round is the highest seen, and a new request starts the board's chips over", () => {
	const s = progressState([L(0, "main", "board", "ok"), L(1, "main", "request", "started"), L(1, "main", "case", "started")])
	assert.equal(s.round, 1)
	assert.deepEqual(Object.keys(s.boards.main.steps).sort(), ["case", "request"])
})

test("settled ok is a tick; nothing is no badge", () => {
	assert.equal(badgeOf(progressState([L(0, "main", "settled", "ok")]).boards.main)?.text, "✓")
	assert.equal(badgeOf(undefined), null)
	assert.deepEqual(progressState([]), { round: 0, boards: {}, system: { step: null, status: null } })
})
