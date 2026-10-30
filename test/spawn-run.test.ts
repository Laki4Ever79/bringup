import assert from "node:assert/strict"
import { test } from "node:test"
import { startRunProcess } from "../src/runner/spawn-run.ts"

const args = { briefPath: "/tmp/b/brief.md", mock: true, outDir: "/tmp/b" }
const node = (code: string): [string, ...string[]] => [process.execPath, "-e", code]

test("exit code and stderr come back through done", async () => {
	const { done } = startRunProcess(args, { command: node("console.error('no docker'); process.exit(2)") })
	const r = await done
	assert.equal(r.code, 2)
	assert.match(r.stderr, /no docker/)
})

test("the run arguments follow the command: brief, --mock, --out", async () => {
	const { done } = startRunProcess(args, { command: node("console.error(JSON.stringify(process.argv.slice(1)))") })
	const r = await done
	assert.equal(r.code, 0)
	assert.deepEqual(JSON.parse(r.stderr), ["/tmp/b/brief.md", "--mock", "--out", "/tmp/b"])
})

test("without mock there is no --mock flag", async () => {
	const { done } = startRunProcess({ ...args, mock: false }, { command: node("console.error(JSON.stringify(process.argv.slice(1)))") })
	assert.deepEqual(JSON.parse((await done).stderr), ["/tmp/b/brief.md", "--out", "/tmp/b"])
})

test("stdout is captured, not inherited", async () => {
	const { done } = startRunProcess(args, { command: node("console.log('mozaik cloud link')") })
	const r = await done
	assert.equal(r.code, 0)
	assert.match(r.stdout, /mozaik cloud link/)
})

test("kill ends the run and reports a failure code", async () => {
	const run = startRunProcess(args, { command: node("setTimeout(() => {}, 60_000)") })
	run.kill()
	const r = await run.done
	assert.notEqual(r.code, 0)
	assert.notEqual(r.code, 2)
	assert.match(r.stderr, /SIGTERM/)
})

test("a missing command resolves with code 1 instead of throwing", async () => {
	const r = await startRunProcess(args, { command: ["/nonexistent/tsx"] }).done
	assert.equal(r.code, 1)
	assert.match(r.stderr, /ENOENT/)
})

test("the default command is tsx running src/main.ts from the repo root", async () => {
	// Only checks where the default points; the real CLI is exercised by the end-to-end tests.
	const { defaultCommand } = await import("../src/runner/spawn-run.ts")
	const [bin, script] = defaultCommand()
	assert.match(bin, /node_modules\/\.bin\/tsx$/)
	assert.match(script, /src\/main\.ts$/)
})

test("onStdout and onStderr see output as it arrives, and done still has it", async () => {
	const out: string[] = []
	const err: string[] = []
	const { done } = startRunProcess(args, {
		command: node("process.stdout.write('one\\n'); setTimeout(() => { process.stdout.write('two\\n'); console.error('warn') }, 100)"),
		onStdout: (c) => out.push(c),
		onStderr: (c) => err.push(c),
	})
	const r = await done
	assert.equal(out.join(""), "one\ntwo\n")
	assert.ok(out.length >= 2, "chunks were delivered as they came, not once at the end")
	assert.equal(err.join(""), "warn\n")
	assert.equal(r.stdout, "one\ntwo\n")
})
