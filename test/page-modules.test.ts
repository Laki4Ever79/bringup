// Every module a dashboard page imports must exist in src/dashboard (the hub serves any plain-named .js file there),
// or the page breaks in the browser only.
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { test } from "node:test"

test("every module the dashboard pages and modules import is a file the hub serves", () => {
	for (const f of readdirSync("src/dashboard").filter((f) => f.endsWith(".html") || f.endsWith(".js"))) {
		const text = readFileSync(`src/dashboard/${f}`, "utf8")
		for (const m of text.matchAll(/(?:from |import\()"\/([^"]+\.js)"/g)) {
			if (m[1] === "contract/builds.js") continue // served from src/contract by its own route
			assert.match(m[1], /^[\w-]+\.js$/, `${f} imports /${m[1]}, a name the hub doesn't serve`)
			assert.ok(existsSync(`src/dashboard/${m[1]}`), `${f} imports /${m[1]}, which is not in src/dashboard`)
		}
	}
})
