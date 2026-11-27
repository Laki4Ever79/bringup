// Firmware and driver sources build with any compiler: no M_PI (glibc and Apple define it, MinGW's strict mode on
// Windows doesn't: OS smoke run 7 failed there on lsm6ds3.h). Each file uses its own guarded BRINGUP_PI.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const sources = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
	const p = join(dir, n)
	return statSync(p).isDirectory() ? sources(p) : /\.(h|hpp|c|cpp|ino)$/.test(n) ? [p] : []
})

test("no template's C or C++ uses M_PI; a file that uses BRINGUP_PI defines it", () => {
	const files = sources("templates")
	assert.ok(files.length > 10)
	const code = (f: string) => readFileSync(f, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
	assert.deepEqual(files.filter((f) => /\bM_PI\b/.test(code(f))), [])
	assert.deepEqual(files.filter((f) => /\bBRINGUP_PI\b/.test(code(f)) && !/#define BRINGUP_PI\b/.test(code(f))), [])
	// Defined before its first use (a late #include put it after one, and inside an #if, in two files).
	assert.deepEqual(files.filter((f) => { const c = code(f); const d = c.indexOf("#define BRINGUP_PI"); const u = c.search(/(?<!define )\bBRINGUP_PI\b(?![\s\S]*#define BRINGUP_PI)/); return d >= 0 && c.slice(0, d).replace(/#ifndef BRINGUP_PI/, "").includes("BRINGUP_PI") }), [])
})
