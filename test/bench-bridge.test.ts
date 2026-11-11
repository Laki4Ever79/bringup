import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const python = resolve(root, ".venv/bin/python")

// The Python side (py/: the bench bridge, its fake and replay sources, the mechanics model and drive, the system bench
// checker), in Python's own unittest. No hardware. One test per module, each with its own time limit: run as one group,
// a slow module under a loaded machine (builds, QEMU, MuJoCo in parallel) ran the whole group past its limit and the
// failure didn't say which test it was (pending-fixes, 11 Nov). Alone the modules take about 40 s in all; under a fully
// loaded CPU about 90 s.
const modules = existsSync(resolve(root, "py/tests")) ? readdirSync(resolve(root, "py/tests")).filter((f) => /^test_.*\.py$/.test(f)).map((f) => f.slice(0, -3)).sort() : []

test("every Python test module is run", () => {
	assert.ok(modules.length >= 9, `found ${modules.join(", ")}`)
})

for (const m of modules)
	test(`py/tests/${m}.py`, { skip: !existsSync(python) && "no .venv python", timeout: 320_000 }, () => {
		const r = spawnSync(python, ["-B", "-m", "unittest", m], { cwd: resolve(root, "py/tests"), encoding: "utf8", timeout: 300_000, env: { ...process.env, PYTHONPATH: resolve(root, "py") } })
		assert.equal(r.status, 0, r.stderr.split("\n").filter((l) => /^(FAIL|ERROR):|Error|assert/i.test(l)).slice(0, 20).join("\n") || r.stderr.slice(-3000))
		assert.match(r.stderr, /^OK/m)
	})
