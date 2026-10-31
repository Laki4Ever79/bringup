import assert from "node:assert/strict"
import { test } from "node:test"
import { shotList } from "../scripts/record-footage.ts"

test("the footage shot list: one line per mark, act file and m:ss within it", () => {
	const list = shotList([{ act: 1, atMs: 0, what: "the hub" }, { act: 3, atMs: 75_400, what: "Consistent again" }])
	assert.match(list, /^- act-1\.webm  0:00  the hub$/m)
	assert.match(list, /^- act-3\.webm  1:15  Consistent again$/m)
})
