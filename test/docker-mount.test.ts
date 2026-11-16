// Rover run cc-rover-8 (16 Nov 2026): `--out out/cc-rover-8` was relative, so docker read the -v source as a volume
// name and the reviewer's power simulation failed. Every docker mount goes through mount(), which is absolute.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { mount } from "../src/tools/mount.ts"

test("a docker mount's host side is absolute, even from a relative path", () => {
	assert.equal(mount("out/x", "/w"), `${process.cwd()}/out/x:/w`)
	assert.equal(mount("/abs/y", "/w"), "/abs/y:/w")
})

test("no docker -v in src builds its host path by hand", () => {
	const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : f.endsWith(".ts") ? [join(d, f)] : []))
	const raw = files("src").filter((f) => /"-v",\s*`/.test(readFileSync(f, "utf8")))
	assert.deepEqual(raw, [])
})
