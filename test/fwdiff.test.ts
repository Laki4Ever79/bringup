// The firmware viewer's diff (src/dashboard/fwdiff.js): what changed between two revisions, file by file and line by line.
import { test } from "node:test"
import assert from "node:assert/strict"
import { compareFiles, hunks, lineDiff } from "../src/dashboard/fwdiff.js"

test("a line diff marks kept, removed and added lines with both sides' line numbers", () => {
	const d = lineDiff("a\nb\nc\n", "a\nB\nc\nd\n")
	assert.deepEqual(d.map((l) => `${l.op} ${l.a ?? "-"} ${l.b ?? "-"} ${l.text}`), ["same 1 1 a", "del 2 - b", "add - 2 B", "same 3 3 c", "add - 4 d"])
	assert.deepEqual(lineDiff("x\n", "x\n").map((l) => l.op), ["same"])
	assert.deepEqual(lineDiff("", "new\n").map((l) => l.op), ["add"])
})

test("hunks keep the changes with a few lines around them and say how much was skipped", () => {
	const a = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n")
	const b = a.replace("line 15", "LINE 15")
	const h = hunks(lineDiff(a, b), 2)
	assert.equal(h.length, 1)
	assert.deepEqual(h[0].lines.map((l) => l.text), ["line 13", "line 14", "line 15", "LINE 15", "line 16", "line 17"])
	assert.equal(h[0].skippedBefore, 12)
	assert.equal(hunks(lineDiff(a, a), 2).length, 0)
})

test("comparing two revisions' file lists says what was added, removed, changed or kept", () => {
	const a = [{ path: "include/pins.h", hash: "1", generated: true }, { path: "src/main.cpp", hash: "2", generated: false }, { path: "include/old.h", hash: "3", generated: true }]
	const b = [{ path: "include/pins.h", hash: "9", generated: true }, { path: "src/main.cpp", hash: "2", generated: false }, { path: "include/link.h", hash: "4", generated: true }]
	assert.deepEqual(compareFiles(a, b).map((f) => `${f.path} ${f.status}`), ["include/link.h added", "include/old.h removed", "include/pins.h changed", "src/main.cpp same"])
	// Without an earlier revision, every file is simply there.
	assert.deepEqual(compareFiles(null, b).map((f) => f.status), ["same", "same", "same"])
})
