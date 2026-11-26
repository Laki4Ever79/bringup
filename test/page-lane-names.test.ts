// Every lane the timeline has gets a name on the board page's agent tiles (26 Nov 2026: the "build:arm" lane was added
// without one, and the tiles crashed on every run, reading WHO["build:arm"][0]).
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { LANES } from "../src/timeline/lanes.js"

test("each timeline lane has a name in the page's WHO table", () => {
	const page = readFileSync(resolve(import.meta.dirname, "../src/dashboard/page.html"), "utf8")
	const who = page.slice(page.indexOf("const WHO = {"), page.indexOf("\n\t}\n", page.indexOf("const WHO = {")))
	const missing = LANES.map((l) => l.key).filter((k) => !new RegExp(`(^|[\\s{,])"?${k.replace(":", "\\:")}"?: \\[`).test(who))
	assert.deepEqual(missing, [])
})
