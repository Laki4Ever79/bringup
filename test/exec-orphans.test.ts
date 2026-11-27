// A run's build children don't outlive it (src/tools/exec.ts): a process that started a child (and the child its own)
// through run() and then exited leaves neither running. Real CNC run 2 (27 Nov 2026) left its board build routing.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

const alive = (pid: number) => {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

test("children run() started, and theirs, are killed when the process exits", { skip: process.platform === "win32" ? "process groups are POSIX" : false }, () => {
	const dir = mkdtempSync(join(tmpdir(), "bringup-orphans-"))
	const pids = join(dir, "pids")
	const script = join(dir, "parent.ts")
	// The child is a shell that starts a grandchild sleep and records both pids; the parent exits 300 ms later.
	writeFileSync(script, `import { run } from ${JSON.stringify(resolve(import.meta.dirname, "../src/tools/exec.ts"))}\nvoid run("sh", ["-c", "sleep 30 & echo $$ $! > ${pids}; wait"], { timeoutMs: 60_000 })\nsetTimeout(() => process.exit(0), 300)\n`)
	const r = spawnSync(process.execPath, ["--import", "tsx", script], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 30_000 })
	assert.equal(r.status, 0, r.stderr)
	const [sh, sleeper] = readFileSync(pids, "utf8").trim().split(" ").map(Number)
	assert.ok(sh > 0 && sleeper > 0)
	spawnSync("sleep", ["0.2"])
	assert.equal(alive(sh), false, "the child shell is gone")
	assert.equal(alive(sleeper), false, "its own child is gone too")
})
