// One KiCad container per process (the isolation audit, 14 Nov 2026: a fresh `docker run` per kicad-cli call, 6 per
// board revision, ~0.7 s each against ~0.3 s for an exec into a running one): calls in the temporary folders go into it,
// the result is the same as before, and it is gone when the process ends.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { detectEnvironment, kicadCli, kicadContainer } from "../src/tools/env.ts"

const env = await detectEnvironment(fileURLToPath(new URL("..", import.meta.url)))

test("kicad-cli calls in a temporary folder share one container, and write where they did before", { skip: env.kicad !== "docker" && "needs the KiCad Docker image" }, async () => {
	const work = mkdtempSync(join(tmpdir(), "kicad-shared-"))
	writeFileSync(join(work, "x.txt"), "hello")
	const a = await kicadCli(env, ["version"], work, 60_000)
	assert.equal(a.code, 0, a.stderr)
	const name = kicadContainer()
	assert.ok(name, "no shared container")
	const b = await kicadCli(env, ["version"], work, 60_000)
	assert.equal(b.code, 0, b.stderr)
	assert.equal(kicadContainer(), name, "a second container was started")
	// It runs in the caller's folder, as the caller's user: a file it writes lands there.
	const w = await kicadCli(env, ["sch", "export", "netlist", "--help"], work, 60_000)
	assert.equal(w.code, 0, w.stderr)
	assert.ok(existsSync(join(work, "x.txt")))
	// Gone when the process ends (checked from a child process that uses it and exits).
	const child = spawnSync(process.execPath, ["--import", "tsx", "-e", `const { detectEnvironment, kicadCli, kicadContainer } = await import(${JSON.stringify(fileURLToPath(new URL("../src/tools/env.ts", import.meta.url)))}); const env = await detectEnvironment(${JSON.stringify(fileURLToPath(new URL("..", import.meta.url)))}); await kicadCli(env, ["version"], ${JSON.stringify(work)}, 60000); console.log(kicadContainer())`], { encoding: "utf8" })
	const childName = child.stdout.trim().split("\n").at(-1)!
	assert.match(childName, /^bringup-kicad-/, child.stderr)
	assert.equal(spawnSync("docker", ["inspect", childName]).status, 1, `${childName} outlived its process`)
})
