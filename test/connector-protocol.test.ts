// The mirror protocol between a local run and Bringup Studio (src/connector/protocol.ts).
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { diffFile, fileState, syncable, WRITEBACK_FILES } from "../src/connector/protocol.ts"

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex")

test("diffFile: growth with the same prefix is an append of the new bytes", () => {
	const before = Buffer.from('{"type":"run.started"}\n')
	const after = Buffer.concat([before, Buffer.from('{"type":"contract.changed"}\n')])
	const c = diffFile(fileState(before), after, "trace.jsonl")
	assert.equal(c.kind, "append")
	assert.ok(c.kind === "append")
	assert.equal(c.offset, before.length)
	assert.equal(Buffer.from(c.data, "base64").toString(), '{"type":"contract.changed"}\n')
})

test("diffFile: a rewritten file is a put with its hash", () => {
	const before = Buffer.from('{"revision":1}')
	const after = Buffer.from('{"revision":2}')
	const c = diffFile(fileState(before), after, "contract.json")
	assert.ok(c.kind === "put")
	assert.equal(c.sha256, sha(after))
	assert.equal(Buffer.from(c.data, "base64").toString(), '{"revision":2}')
	// A file seen for the first time is a put; one that shrank too.
	assert.equal(diffFile(undefined, after, "contract.json").kind, "put")
	assert.equal(diffFile(fileState(Buffer.from("abcdef")), Buffer.from("abc"), "x.txt").kind, "put")
	// Same prefix length but other bytes: a put, never an append on a stale prefix.
	assert.equal(diffFile(fileState(Buffer.from("aaa")), Buffer.from("bbbccc"), "x.txt").kind, "put")
})

test("syncable: build folders and files over 32 MB are skipped; contract.json and trace.jsonl are kept", () => {
	assert.ok(syncable("contract.json", 4_000))
	assert.ok(syncable("trace.jsonl", 2_000_000))
	assert.ok(syncable("board/rev-3/board.png", 300_000))
	assert.ok(syncable("firmware/rev-2/firmware.bin", 1_000_000))
	for (const p of ["firmware/rev-2/fw/.pio/build/x.o", "node_modules/a/index.js", "package/.work/board/x.json", "fw/.pio/libdeps/a.h", ".studio/applied.json"]) assert.ok(!syncable(p, 10), p)
	assert.ok(!syncable("firmware/rev-2/firmware.elf", 10))
	assert.ok(!syncable("firmware/rev-2/big.bin", 5 * 1024 * 1024))
	assert.ok(!syncable("sim/clip.webm", 33 * 1024 * 1024))
	// Windows-style separators are judged the same.
	assert.ok(!syncable("firmware\\rev-2\\fw\\.pio\\x.o", 10))
})

test("WRITEBACK_FILES names exactly the files the hub appends", () => {
	const constant = (file: string, name: string) => new RegExp(`export const ${name} = "([^"]+)"`).exec(readFileSync(file, "utf8"))![1]
	const appended = [
		constant("src/runner/requests.ts", "REQUESTS_FILE"),
		constant("src/runner/decisions.ts", "DECISIONS_FILE"),
		constant("src/runner/steer.ts", "STEER_COMMANDS_FILE"),
		constant("src/runner/drift.ts", "DRIFT_ACTIONS_FILE"),
		constant("src/system/run.ts", "SYSTEM_REQUESTS"),
		constant("src/bench/bench-commands.ts", "BENCH_COMMANDS_FILE"),
	]
	assert.deepEqual([...WRITEBACK_FILES].sort(), appended.sort())
})

test("the connector never imports the private page or the server", () => {
	for (const f of readdirSync("src/connector")) {
		const src = readFileSync(`src/connector/${f}`, "utf8")
		assert.ok(!/from ["'][^"']*(\/dashboard\/|\/cloud\/|\.\.\/\.\.\/cloud)/.test(src), f)
	}
})
