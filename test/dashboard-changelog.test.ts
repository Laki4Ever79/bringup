import assert from "node:assert/strict"
import { test } from "node:test"
import { causeText, changeLog, defaultRange, readableDiff } from "../src/dashboard/changelog.js"

let seq = 0
const changed = (revision: number, field: string, version: number, by: string, extra: object = {}) => ({ seq: seq++, at: `2026-10-31T12:00:${String(revision).padStart(2, "0")}.000Z`, type: "contract.changed", producerId: "x", payload: { field, version, revision, by, ...extra } })

test("readable diffs: outline as W×H mm, list fields by key", () => {
	assert.deepEqual(readableDiff("outline", { widthMm: 50, heightMm: 30, thicknessMm: 1.6 }, { widthMm: 40, heightMm: 30, thicknessMm: 1.6 }), ["outline 50×30 → 40×30 mm"])
	assert.deepEqual(readableDiff("pins", [{ signal: "I2C_SDA", gpio: 8, partRef: "U2", partPin: "SDA" }], [{ signal: "I2C_SDA", gpio: 8, partRef: "U2", partPin: "SDA" }, { signal: "STATUS_LED", gpio: 10, partRef: "D1", partPin: "A" }]), ["+ STATUS_LED → GPIO10 (D1.A)"])
	assert.deepEqual(readableDiff("parts", [{ ref: "U2", mpn: "SHT40-AD1B-R2", footprint: "x" }], [{ ref: "U2", mpn: "SHTC3", footprint: "x" }]), ["~ U2 SHT40-AD1B-R2 → SHTC3"])
	assert.deepEqual(readableDiff("behavior", { blinkMs: 1000, tiltBlinkMs: 1000, tiltDeg: 90 }, { blinkMs: 1000, tiltBlinkMs: 250, tiltDeg: 20 }), ["~ tiltBlinkMs 1000 → 250", "~ tiltDeg 90 → 20"])
	assert.deepEqual(readableDiff("outline", null, { widthMm: 50, heightMm: 30 }), ["outline 50×30 mm (first)"])
})

test("causes in words, with what to link to", () => {
	assert.deepEqual(causeText({ kind: "brief" }), { text: "the brief", link: null })
	assert.deepEqual(causeText({ kind: "request", id: "req-2", text: "make it 40 mm wide" }), { text: "request #2 “make it 40 mm wide”", link: { ripple: "req-2" } })
	assert.deepEqual(causeText({ kind: "violation", revision: 6, items: [{ kind: "cutout-misaligned", message: "cutout for J1 is left@15" }, { kind: "fit", message: "x" }] }), { text: "consistency at rev 6: cutout-misaligned: cutout for J1 is left@15 (+1 more)", link: { checks: "consistency" } })
	assert.deepEqual(causeText({ kind: "review", revision: 9, items: [{ severity: "major", fields: ["rails"], issue: "the LDO draws 55 µA" }] }), { text: "brief review at rev 9 (major): the LDO draws 55 µA", link: { checks: "review" } })
	assert.deepEqual(causeText({ kind: "approval", proposalId: "p-3", approvedBy: ["architect"], reason: "GPIO10 is free" }), { text: "approved by Architect: “GPIO10 is free”", link: { changes: "p-3" } })
	assert.deepEqual(causeText({ kind: "build-failed", artifact: "board", revision: 5, error: "unknown footprint" }), { text: "the board build failed at rev 5: unknown footprint", link: null })
	assert.deepEqual(causeText({ kind: "field-changed", fields: ["requirements", "rails"] }), { text: "requirements or rails changed", link: null })
	assert.deepEqual(causeText(undefined), { text: "cause not recorded (older run)", link: null })
})

test("the change log between two revisions: per write, who, the diff, the reason and the cause", () => {
	const events = [
		changed(4, "outline", 1, "architect", { reason: "50 × 30 mm from the brief", before: null, after: { widthMm: 50, heightMm: 30 }, cause: { kind: "brief" } }),
		changed(5, "pins", 1, "architect", { reason: "I2C and the LED", before: null, after: [], cause: { kind: "brief" } }),
		changed(6, "outline", 2, "architect", { reason: "engineer asked for 40 mm wide", before: { widthMm: 50, heightMm: 30 }, after: { widthMm: 40, heightMm: 30 }, cause: { kind: "request", id: "req-1", text: "make it 40 mm wide" } }),
	]
	const log = changeLog(events, 5, 6, new Map())
	assert.equal(log.length, 1)
	assert.deepEqual(log[0], { revision: 6, field: "outline", version: 2, by: "architect", who: "Architect", diff: ["outline 50×30 → 40×30 mm"], reason: "engineer asked for 40 mm wide", cause: { text: "request #1 “make it 40 mm wide”", link: { ripple: "req-1" } } })
	assert.deepEqual(changeLog(events, 3, 6, new Map()).map((e) => e.revision), [4, 5, 6])
})

test("an older trace (no reason, no values) still shows field, who and revision, with the diff from the revision snapshots", () => {
	const events = [changed(7, "outline", 2, "architect")]
	const snapshots = new Map([[6, { revision: 6, values: { outline: { widthMm: 50, heightMm: 30 } } }], [7, { revision: 7, values: { outline: { widthMm: 40, heightMm: 30 } } }]])
	const [e] = changeLog(events, 6, 7, snapshots)
	assert.equal(e.reason, null)
	assert.deepEqual(e.diff, ["outline 50×30 → 40×30 mm"])
	assert.equal(e.cause.text, "cause not recorded (older run)")
	// Without the snapshots either: nothing invented.
	assert.deepEqual(changeLog(events, 6, 7, new Map())[0].diff, [])
})

test("the default view is the latest two revisions", () => {
	assert.deepEqual(defaultRange([changed(3, "a", 1, "architect"), changed(9, "b", 1, "parts"), changed(8, "c", 1, "parts")]), { from: 8, to: 9 })
	assert.deepEqual(defaultRange([changed(1, "a", 1, "architect")]), { from: 0, to: 1 })
	assert.equal(defaultRange([]), null)
})
