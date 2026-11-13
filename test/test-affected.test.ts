// npm run test:affected (scripts/test-affected.ts): which tests a change touches.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { affectedTests, importGraph } from "../scripts/test-affected.ts"

function repo(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "affected-"))
	for (const [p, text] of Object.entries(files)) {
		mkdirSync(join(root, p, ".."), { recursive: true })
		writeFileSync(join(root, p), text)
	}
	return root
}

// Fixture sources, spelled so this file's own import scan doesn't read them as imports of the real repo.
const F = "fr" + "om"
const root = repo({
	"src/mcu/solver.ts": "export const s = 1\n",
	"src/mcu/select.ts": `import { s } ${F} "./solver.ts"\nexport const r = s\n`,
	"src/codegen/circuit.ts": `import {\n  s,\n} ${F} "../mcu/solver.ts"\nexport const c = s\n`,
	"src/board.ts": `import { c } ${F} "./codegen/circuit.ts"\nexport const b = c\n`,
	"src/types.ts": "export type T = number\n",
	"test/solver.test.ts": `import { s } ${F} "../src/mcu/solver.ts"\nimport type { T } ${F} "../src/types.ts"\n`,
	"test/select.test.ts": `import { r } ${F} "../src/mcu/select.ts"\n`,
	"test/circuit.test.ts": `const m = await imp${"ort"}("../src/codegen/circuit.ts")\n`,
	"test/board.test.ts": `import { b } ${F} "../src/board.ts"\n`,
	"test/board-build.int.test.ts": "// builds boards from files read at run time\n",
})
const graph = importGraph(root)
const names = (t: string[]) => t.map((f) => f.slice(5, -8))

test("a change runs the tests that import it and those of the modules beside it that use it", () => {
	// circuit.ts imports the solver from another directory: its tests come with --wide.
	assert.deepEqual(names(affectedTests(["src/mcu/solver.ts"], graph, root, 1, {})), ["select", "solver"])
	assert.deepEqual(names(affectedTests(["src/mcu/solver.ts"], graph, root, 2, {})), ["circuit", "select", "solver"])
})

test("the hand list covers what imports can't show, for the file and the modules that import it", () => {
	const hand = { "src/codegen/circuit.ts": ["board-build.int"] }
	assert.deepEqual(names(affectedTests(["src/codegen/circuit.ts"], graph, root, 1, hand)), ["board-build.int", "circuit"])
	assert.ok(names(affectedTests(["src/mcu/solver.ts"], graph, root, 1, hand)).includes("board-build.int"))
})

test("type-only imports don't count; --wide and --deep follow longer chains", () => {
	assert.deepEqual(affectedTests(["src/types.ts"], graph, root), [])
	assert.ok(!names(affectedTests(["src/mcu/solver.ts"], graph, root, 1, {})).includes("board"))
	assert.ok(names(affectedTests(["src/mcu/solver.ts"], graph, root, Infinity, {})).includes("board"))
})

test("a changed test runs itself", () => {
	assert.deepEqual(names(affectedTests(["test/board.test.ts"], graph, root, 1, {})), ["board"])
})
