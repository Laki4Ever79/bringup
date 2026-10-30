import { test } from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { startBridge, type BridgeLine } from "../src/tools/bench-bridge.ts"

const FAKE = fileURLToPath(new URL("./data/fake-bridge.mjs", import.meta.url))

test("the bridge client reads hello, routes acks to their command and passes every other line on", async () => {
	const lines: BridgeLine[] = []
	const stderr: string[] = []
	const bridge = startBridge(process.execPath, [FAKE, "fake"], { onStderr: (t) => stderr.push(t) })
	bridge.onLine((l) => lines.push(l))
	const hello = await bridge.hello
	assert.equal(hello.source, "fake")
	assert.equal(hello.meter, true)
	const ack = await bridge.command({ cmd: "flash", dir: "/tmp/x" })
	assert.equal(ack.ok, true)
	assert.equal(ack.ms, 12)
	const failed = await bridge.command({ cmd: "recover" })
	assert.deepEqual([failed.ok, failed.error], [false, "no fixture"])
	await new Promise((r) => setTimeout(r, 50))
	assert.deepEqual(lines.filter((l) => l.k === "flashing").map((l) => l.pct), [0, 50])
	assert.ok(lines.some((l) => l.k === "boot" && l.rev === 7))
	assert.ok(!lines.some((l) => l.k === "ack"), "acks go to their command, not to the listeners")
	assert.ok(lines.some((l) => l.k === "text" && l.text === "not json"), "a non-JSON line becomes a text line")
	await bridge.close()
	assert.ok(stderr.join("").includes("bridge: started"))
})

test("a command to a bridge that has exited fails instead of hanging", async () => {
	const bridge = startBridge(process.execPath, [FAKE])
	await bridge.hello
	await bridge.close()
	const ack = await bridge.command({ cmd: "reset" })
	assert.equal(ack.ok, false)
	assert.match(ack.error ?? "", /exited|closed/)
})

test("a bridge that never starts rejects hello", async () => {
	const bridge = startBridge("/nonexistent/python", ["py/bench.py"])
	await assert.rejects(bridge.hello)
})
