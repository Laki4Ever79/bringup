// Every module a dashboard page imports must be on the server's list, or the page breaks in the browser only.
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { test } from "node:test"

test("the hub serves every module the dashboard pages import", () => {
	const served = new Set(JSON.parse(/const MODULES = new Set\((\[[^\]]*\])\)/.exec(readFileSync("src/dashboard/server.ts", "utf8"))![1]))
	for (const page of readdirSync("src/dashboard").filter((f) => f.endsWith(".html"))) {
		const html = readFileSync(`src/dashboard/${page}`, "utf8")
		for (const m of html.matchAll(/from "\/([\w-]+\.js)"/g)) assert.ok(served.has(m[1]), `${page} imports /${m[1]}, which the server doesn't serve`)
	}
})
