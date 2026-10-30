import { test } from "node:test"
import assert from "node:assert/strict"
import { DesignContract } from "../src/contract/contract.ts"

const outline = { widthMm: 50, heightMm: 30, thicknessMm: 1.6 }

test("owner write applies", () => {
	const c = new DesignContract()
	const r = c.propose({ field: "outline", value: outline, by: "architect", baseVersion: 0 })
	assert.deepEqual(r, { status: "applied", version: 1, revision: 1 })
	assert.equal(c.get("outline")?.widthMm, 50)
})

test("stale base is refused", () => {
	const c = new DesignContract()
	c.propose({ field: "outline", value: outline, by: "architect", baseVersion: 0 })
	const r = c.propose({ field: "outline", value: { ...outline, widthMm: 60 }, by: "architect", baseVersion: 0 })
	assert.deepEqual(r, { status: "stale", current: 1 })
	assert.equal(c.get("outline")?.widthMm, 50)
})

test("non-owner refused without approval", () => {
	const c = new DesignContract()
	const r = c.propose({ field: "pins", value: [], by: "firmware", baseVersion: 0 })
	assert.deepEqual(r, { status: "not-owner", owner: "architect" })
})

test("non-owner applies with owner approval", () => {
	const c = new DesignContract()
	const r = c.propose({ field: "pins", value: [], by: "firmware", baseVersion: 0, approvedBy: "architect" })
	assert.equal(r.status, "applied")
})

test("snapshot is a copy", () => {
	const c = new DesignContract()
	c.propose({ field: "outline", value: outline, by: "architect", baseVersion: 0 })
	const s = c.snapshot()
	s.values.outline!.widthMm = 99
	assert.equal(c.get("outline")?.widthMm, 50)
})

test("pin signals must be UPPER_SNAKE", () => {
	const c = new DesignContract()
	const r = c.propose({ field: "pins", value: [{ signal: "status-led", gpio: 10, partRef: "D1", partPin: "A" }], by: "architect", baseVersion: 0 })
	assert.equal(r.status, "invalid")
	assert.equal(c.version("pins"), 0)
})

test("an identical value is reported unchanged and not applied", () => {
	const c = new DesignContract()
	c.propose({ field: "outline", value: outline, by: "architect", baseVersion: 0 })
	const r = c.propose({ field: "outline", value: { ...outline }, by: "architect", baseVersion: 1 })
	assert.deepEqual(r, { status: "unchanged", version: 1 })
	assert.equal(c.revision, 1)
})
