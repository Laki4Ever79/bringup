import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { PRIVATE_ROOTS, privateFiles, publicPackageJson, staticImports } from "../scripts/publish-public.ts"
import { sharedFromWorkingTree } from "../scripts/publish-public.ts"

// The npm package carries the page modules the engine reaches and nothing else of the page (the open-core split,
// 25 Nov 2026: 0.2.1's first cut missed changelog.js, which ask.ts loads, so a real run through npx would have crashed).
test("npm package files re-include exactly the page modules the engine reaches", () => {
	const files: string[] = JSON.parse(readFileSync("package.json", "utf8")).files
	assert.ok(files.includes("!src/dashboard/**"))
	// Every private root is out of the package too (src/demo.ts serves the page; 0.2.1's first pack still had it).
	for (const r of PRIVATE_ROOTS) assert.ok(files.includes(r.endsWith("/") ? `!${r}**` : `!${r}`) || !files.some((f) => r.startsWith(f) && !f.startsWith("!")) , `package.json files must exclude ${r}`)
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

// The finished examples are private (the user, 25 Nov 2026: "examples should stay on private repo"); examples/learn
// (the datasheet fixtures) stays public, and a test that reads a private example by path goes with it.
test("examples are private except examples/learn; tests reading them by path go too", () => {
	// Built from parts, so this test doesn't name a private file itself.
	const pi = ["examples", "rover-pi", "boards", "main", "contract.json"].join("/")
	const src: Record<string, string> = {
		[pi]: "{}",
		"examples/learn/esp32.json": "{}",
		"test/screws.test.ts": `const c = readFileSync("${pi}", "utf8")`,
		"test/learn.test.ts": 'const FIX = resolve(import.meta.dirname, "../examples/learn")',
		"scripts/affected.ts": 'const MAP = { "examples/": ["starters"] }',
	}
	const { out } = privateFiles(Object.keys(src), (f) => src[f])
	assert.deepEqual([...out].sort(), [pi, "test/screws.test.ts"])
	const files: string[] = JSON.parse(readFileSync("package.json", "utf8")).files
	assert.ok(files.includes("examples/learn/") && !files.includes("examples/"))
})
