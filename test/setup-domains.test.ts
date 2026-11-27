// Installing one domain's tools into the tools home (src/setup/domains.ts), and finding them there (src/tools/env.ts).
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DOMAINS, describeDomain, installDomain, installedDomains, setupCli } from "../src/setup/domains.ts"
import { bringupHome, toolAt } from "../src/tools/env.ts"
import { missingBuilders } from "../src/tools/stubs.ts"
import { tempDir } from "./helpers.ts"

test("each domain says what it downloads, how big and how long, before anything is installed", () => {
	assert.match(describeDomain("board"), /^board: about 923 MB and 35 s, once, for tscircuit and bun, pinned .*; gives a routed board, its fab files and pictures of it$/)
	assert.match(describeDomain("case"), /^case: about 945 MB .*build123d/)
	assert.match(DOMAINS.case.needs!, /libGL\.so\.1.*apt install libgl1/)
	assert.match(describeDomain("firmware"), /^firmware: about 125 MB .*PlatformIO .* about 1 GB more \(an estimate\)/)
})

test("setup with no domain only lists them; an unknown domain is refused; nothing is installed", async () => {
	const said: string[] = []
	const err = console.error
	console.error = (m: string) => said.push(m)
	try {
		assert.equal(await setupCli([]), 0)
		assert.equal(await setupCli(["cad"]), 2)
	} finally {
		console.error = err
	}
	assert.match(said.join("\n"), /usage: npx bringup-mcp setup <board\|case\|firmware\|all>/)
	assert.match(said.join("\n"), /unknown domain: cad/)
})

test("board: the pinned lockfile goes into the tools home and npm ci installs it there; a second run is a no-op", async () => {
	const home = tempDir()
	const calls: string[][] = []
	const exec = async (cmd: string, args: string[], opts?: { cwd?: string }) => {
		calls.push([cmd, ...args])
		// npm ci "installs", in the folder it runs in: the .bin/tsci it would put there.
		if (cmd === "npm") {
			const prefix = opts!.cwd!
			mkdirSync(join(prefix, "node_modules", ".bin"), { recursive: true })
			writeFileSync(join(prefix, "node_modules", ".bin", "tsci"), "")
		}
		return 0
	}
	const r = await installDomain("board", { home, exec, log: () => {} })
	assert.equal(r.installed, true)
	assert.deepEqual(calls[0].slice(0, 2), ["npm", "ci"])
	assert.ok(!calls[0].includes("--prefix"), "npm ci runs in the tools folder, not through --prefix")
	assert.ok(existsSync(join(home, "tools", "node", "package-lock.json")), "the tested lockfile, so nothing floats")
	assert.equal(JSON.parse(readFileSync(join(home, "tools", "node", "package-lock.json"), "utf8")).lockfileVersion > 0, true)
	assert.deepEqual(installedDomains(home), ["board"])
	assert.equal((await installDomain("board", { home, exec, log: () => {} })).installed, false)
	assert.equal(calls.length, 1)
})

test("case: uv's pinned download is refused when its checksum doesn't match (nothing installed)", async () => {
	const home = tempDir()
	const exec = async (cmd: string) => (cmd === "uv" ? 127 : 0) // no uv on PATH
	const fetch = (async () => new Response("not uv", { status: 200 })) as unknown as typeof globalThis.fetch
	await assert.rejects(installDomain("case", { home, exec, fetch, log: () => {} }), /checksum is .* not the pinned/)
	assert.ok(!existsSync(join(home, "tools", "uv", "uv")))
})

test("case: installed but the CAD kernel can't load: the note names the missing system library", async () => {
	const home = tempDir()
	let imports = 0
	const exec = async (cmd: string, args: string[]) => {
		if (cmd === "uv" && args[0] === "--version") return 0
		if (args[0] === "-c") return ++imports === 1 ? 1 : 1 // build123d never imports (no libGL)
		if (cmd === "uv" && args[0] === "venv") {
			mkdirSync(join(home, ".venv", "bin"), { recursive: true })
			writeFileSync(join(home, ".venv", "bin", "python"), "")
		}
		return 0
	}
	const r = await installDomain("case", { home, exec, log: () => {} })
	assert.equal(r.installed, true)
	assert.match(r.note, /can't load here: it needs the system's OpenGL library \(libGL\.so\.1\)/)
})

test("a tool is found in the repo first, else in the tools home (BRINGUP_HOME)", () => {
	const repo = tempDir()
	const home = tempDir()
	const before = process.env.BRINGUP_HOME
	process.env.BRINGUP_HOME = home
	try {
		assert.equal(bringupHome(), home)
		assert.equal(toolAt(repo, ".venv/bin/python"), null)
		mkdirSync(join(home, ".venv", "bin"), { recursive: true })
		writeFileSync(join(home, ".venv", "bin", "python"), "")
		assert.equal(toolAt(repo, ".venv/bin/python"), join(home, ".venv/bin/python"))
		mkdirSync(join(repo, ".venv", "bin"), { recursive: true })
		writeFileSync(join(repo, ".venv", "bin", "python"), "")
		assert.equal(toolAt(repo, ".venv/bin/python"), join(repo, ".venv/bin/python"))
	} finally {
		if (before === undefined) delete process.env.BRINGUP_HOME
		else process.env.BRINGUP_HOME = before
	}
})

test("--stub-missing: only the builders whose tools are missing are stubbed", () => {
	assert.deepEqual(missingBuilders({ tsci: "/t", python: null, pio: null }).sort(), ["arm", "armsim", "chassis", "cncsim", "drive", "enclosure", "firmware"])
	assert.deepEqual(missingBuilders({ tsci: null, python: "/p", pio: "/q" }).sort(), ["board", "testkit"])
	assert.deepEqual(missingBuilders({ tsci: "/t", python: "/p", pio: "/q" }), [])
})

test("a CAD kernel that can't load libGL is explained, not shown as a Python ImportError", async () => {
	const { explainToolError } = await import("../src/tools/explain.ts")
	const raw = 'Traceback (most recent call last):\n  File "py/enclosure.py", line 3, in <module>\n    from OCP.OCP import *\nImportError: libGL.so.1: cannot open shared object file: No such file or directory'
	assert.match(explainToolError(raw)!, /lacks the system's OpenGL library \(libGL\.so\.1\)\. On Debian or Ubuntu: sudo apt install libgl1/)
	assert.equal(explainToolError("ValueError: the lid doesn't fit"), null)
})
