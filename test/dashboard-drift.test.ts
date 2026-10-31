import assert from "node:assert/strict"
import { test } from "node:test"
import { driftView } from "../src/dashboard/model.js"

// The Drift drawer: saved edits outside the contract (drift.json, owned by the run), with Adopt / Revert.
const entry = (o: object) => ({ id: "drift-1", path: "firmware/rev-7/include/pins.h", savedAt: "2026-10-31T12:50:42.000Z", savedRevision: 7, designRevision: 7, kind: "not-in-contract", items: ["+ #define DEBUG_LOG 1"], status: "open", adoptable: false, note: "a #define with no contract field", ...o })

test("an open edit outside the contract: file, diff, the warning, Revert on, Adopt off with the reason", () => {
	const v = driftView({ live: true, entries: [entry({})] })
	assert.equal(v.open, 1)
	assert.deepEqual(v.rows[0], {
		id: "drift-1", name: "pins.h", path: "firmware/rev-7/include/pins.h", at: "2026-10-31T12:50:42.000Z", items: ["+ #define DEBUG_LOG 1"],
		kind: "not in the design", message: "not in the design contract; the next rebuild will overwrite it", status: "open",
		revert: { enabled: true, reason: "" }, adopt: { enabled: false, reason: "a #define with no contract field" }, requestId: null,
	})
})

test("a stale save that maps is adoptable; its message says which revisions", () => {
	const r = driftView({ live: true, entries: [entry({ id: "drift-2", kind: "stale", savedRevision: 6, items: ["I2C_SCL GPIO9 → GPIO3"], adoptable: true, note: undefined })] }).rows[0]
	assert.equal(r.kind, "stale save")
	assert.equal(r.message, "saved against rev 6, the design is at rev 7")
	assert.deepEqual(r.adopt, { enabled: true, reason: "" })
})

test("resolved entries link to their change request and offer no buttons; the badge counts open ones only; newest first", () => {
	const v = driftView({ live: true, entries: [entry({ id: "drift-1", savedAt: "2026-10-31T12:00:00.000Z", kind: "adopted", status: "adopted", requestId: "req-3", adoptable: true }), entry({ id: "drift-2", savedAt: "2026-10-31T12:05:00.000Z", status: "reverted" }), entry({ id: "drift-3", savedAt: "2026-10-31T12:09:00.000Z" })] })
	assert.equal(v.open, 1)
	assert.deepEqual(v.rows.map((r) => r.id), ["drift-3", "drift-2", "drift-1"])
	const adopted = v.rows[2]
	assert.equal(adopted.status, "adopted")
	assert.equal(adopted.requestId, "req-3")
	assert.equal(adopted.message, "became change request #3")
	assert.equal(adopted.revert.enabled, false)
	assert.equal(adopted.adopt.enabled, false)
	assert.equal(v.rows[1].message, "reverted to the generated file")
})

test("after the run ended nothing can be acted on, and the buttons say so; no drift.json is an empty panel", () => {
	const r = driftView({ live: false, entries: [entry({ adoptable: true, note: undefined })] }).rows[0]
	assert.deepEqual(r.revert, { enabled: false, reason: "the run has ended" })
	assert.deepEqual(r.adopt, { enabled: false, reason: "the run has ended" })
	assert.deepEqual(driftView(null), { open: 0, rows: [], live: false })
})
