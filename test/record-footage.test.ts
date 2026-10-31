import assert from "node:assert/strict"
import { test } from "node:test"
import { shotList } from "../scripts/record-footage.ts"

test("the footage shot list: one line per mark, act file and m:ss within it", () => {
	const list = shotList([{ act: 1, atMs: 0, what: "the hub" }, { act: 3, atMs: 75_400, what: "Consistent again" }])
	assert.match(list, /^- act-1\.webm  0:00  the hub$/m)
	assert.match(list, /^- act-3\.webm  1:15  Consistent again$/m)
})

test("re-recording some acts keeps the other acts' lines in the shot list", () => {
	const old = shotList([{ act: 1, atMs: 0, what: "old hub" }, { act: 2, atMs: 3000, what: "first design" }, { act: 3, atMs: 7000, what: "typing" }])
	const merged = shotList([{ act: 1, atMs: 1000, what: "new hub" }], { keep: old, acts: [1] })
	assert.doesNotMatch(merged, /old hub/)
	assert.match(merged, /^- act-1\.webm  0:01  new hub$/m)
	assert.match(merged, /^- act-2\.webm  0:03  first design$/m)
	assert.match(merged, /^- act-3\.webm  0:07  typing$/m)
	assert.ok(merged.indexOf("act-1") < merged.indexOf("act-2"), "in act order")
})
