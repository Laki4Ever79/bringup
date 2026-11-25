import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { privateFiles, publicPackageJson, staticImports } from "../scripts/publish-public.ts"
import { sharedFromWorkingTree } from "../scripts/publish-public.ts"

// The npm package carries the page modules the engine reaches and nothing else of the page (the open-core split,
// 25 Nov 2026: 0.2.1's first cut missed changelog.js, which ask.ts loads, so a real run through npx would have crashed).
test("npm package files re-include exactly the page modules the engine reaches", () => {
	const files: string[] = JSON.parse(readFileSync("package.json", "utf8")).files
	assert.ok(files.includes("!src/dashboard/**"))
	assert.deepEqual(files.filter((f) => f.startsWith("src/dashboard/")).sort(), sharedFromWorkingTree())
})

test("the filter leaves out the page and what imports it, keeps what the engine reaches", () => {
	const src: Record<string, string> = {
		"src/main.ts": 'import { a } from "./dashboard/geom.js"\nconst s = "./dashboard/server.ts"; const p = await import(s)',
		"src/dashboard/geom.js": "export const a = 1",
		"src/dashboard/geom.d.ts": "export const a: number",
		"src/dashboard/server.ts": 'import "./page.js"',
		"src/dashboard/page.js": "",
		"test/page.test.ts": 'import "../src/dashboard/server.ts"',
		"test/engine.test.ts": 'import "../src/main.ts"',
	}
	const { out, shared } = privateFiles(Object.keys(src), (f) => src[f])
	assert.deepEqual([...out].sort(), ["src/dashboard/page.js", "src/dashboard/server.ts", "test/page.test.ts"])
	assert.deepEqual(shared, ["src/dashboard/geom.d.ts", "src/dashboard/geom.js"])
	assert.deepEqual(staticImports('const x = await import("./y.ts")'), ["./y.ts"])
	assert.deepEqual(staticImports('const m = "./y.ts"; await import(m)'), [])
	const pkg = publicPackageJson(JSON.stringify({ scripts: { dashboard: "tsx src/dashboard/cli.ts", start: "tsx src/main.ts" } }), out)
	assert.deepEqual(Object.keys(JSON.parse(pkg).scripts), ["start"])
})
