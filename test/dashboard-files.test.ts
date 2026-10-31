import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { filesView } from "../src/dashboard/model.js"

// The Files panel: the linked folder, your edits (in plain words, one action each) and the git history of the design.
// Fixture: 5b's docs/runs/linked/files.json, exactly what GET /api/runs/:id/files returned.
const files = JSON.parse(readFileSync(new URL("./data/linked/files.json", import.meta.url), "utf8"))

test("the chip names the folder, git and the open edits; no folder and no edits shows nothing", () => {
	assert.equal(filesView({ ...files, live: true }).chip, "linked-2-design · git · 1 edit")
	assert.equal(filesView({ ...files, live: true, entries: files.entries.filter((e: any) => e.status !== "open") }).chip, "linked-2-design · git · clean")
	assert.equal(filesView({ linked: null, entries: [] }).show, false)
	assert.equal(filesView({ linked: null, entries: [files.entries[3]] }).show, true, "edits without a linked folder still show")
	assert.equal(filesView(null).show, false)
})

test("your edits in plain words, one action each; the re-save folds away", () => {
	const v = filesView({ ...files, live: true })
	const by = Object.fromEntries(v.edits.map((e: any) => [e.id, e]))
	assert.equal(by["drift-4"].says, "not in the design: the next rebuild will overwrite it")
	assert.equal(by["drift-4"].action, "revert")
	assert.equal(by["drift-1"].says, "adopted: change request #1")
	assert.equal(by["drift-2"].says, "applied on top of the current design: change request #3")
	assert.equal(by["drift-2"].action, null)
	assert.equal(by["drift-3"].folded, true)
	assert.equal(by["drift-3"].says, "re-saved, no design change")
	// Open first, then newest.
	assert.equal(v.edits[0].id, "drift-4")
	// A same-field clash is held for the field's owner.
	const held = filesView({ linked: null, live: true, entries: [{ ...files.entries[1], id: "drift-9", kind: "stale", status: "adopted", note: "conflict: pins changed since rev 8; sent to the owner of pins to decide" }] }).edits[0]
	assert.equal(held.says, "clashes with a newer change: waiting for the owner of pins")
	// An open stale edit that maps can be adopted.
	const adoptable = filesView({ linked: null, live: true, entries: [{ ...files.entries[3], id: "drift-8", kind: "stale", adoptable: true, items: ["I2C_SDA GPIO8 → GPIO4"] }] }).edits[0]
	assert.equal(adoptable.action, "adopt")
})

test("the history: one entry per settled revision, short id, the change without the 'Bringup rev N:' prefix, its source", () => {
	const v = filesView({ ...files, live: true })
	assert.deepEqual(v.history.map((h: any) => [h.id, h.revision, h.source]), [["68d8b1b", 10, "file"], ["136cf9c", 8, "file"], ["6c53df9", 7, "brief"]])
	assert.equal(v.history[1].subject, "edited pins.h: I2C_SDA GPIO8 → GPIO4")
	assert.equal(v.history[1].sourceLabel, "file edit")
	assert.equal(v.history[2].sourceLabel, "the brief")
	assert.equal(v.folder, "out/linked-2-design")
	assert.equal(v.dirty, true)
})
