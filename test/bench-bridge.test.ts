import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const python = resolve(root, ".venv/bin/python")

// The bench bridge (py/bench.py) and its fake and replay sources, in Python's own unittest. No hardware.
test("py/bench.py: units and the bridge protocol against the fake bench", { skip: !existsSync(python) && "no .venv python", timeout: 320_000 }, () => {
	const r = spawnSync(python, ["-B", "-m", "unittest", "discover", "-s", "py/tests"], { cwd: root, encoding: "utf8", timeout: 300_000 })
	assert.equal(r.status, 0, r.stderr)
	assert.match(r.stderr, /^OK$/m)
})
