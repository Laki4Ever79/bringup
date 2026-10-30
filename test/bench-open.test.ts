import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { benchArgs, latestRecording, openBench } from "../src/bench/open.ts"
import type { Bridge, BridgeHello } from "../src/tools/bench-bridge.ts"
import { tempDir } from "./helpers.ts"

function fakeStart(dutFor: Record<string, string | null>) {
	const started: string[][] = []
	const closed: string[] = []
	const start = (args: string[]): Bridge => {
		started.push(args)
		const source = args[args.indexOf("--source") + 1] as BridgeHello["source"]
		const hello: BridgeHello = { source, ports: { dut: dutFor[source] ?? null, fixture: null, telemetry: null }, meter: true }
		return { hello: Promise.resolve(hello), onLine: () => {}, command: async () => ({ ok: true }), close: async () => void closed.push(source) }
	}
	return { start, started, closed }
}

test("the bridge is started with the source, the run's bench dir and the replay file", () => {
	assert.deepEqual(benchArgs("/repo", "replay", "/out/run1", "/rec.jsonl"), ["/repo/py/bench.py", "--source", "replay", "--out", "/out/run1/bench", "--replay", "/rec.jsonl"])
	assert.deepEqual(benchArgs("/repo", "real", "/out/run1"), ["/repo/py/bench.py", "--source", "real", "--out", "/out/run1/bench"])
})

test("real with a board plugged in stays real", async () => {
	const f = fakeStart({ real: "/dev/serial/by-id/usb-Espressif_USB_JTAG" })
	const b = await openBench({ root: tempDir(), source: "real", outDir: "/out/r", start: f.start, log: () => {} })
	assert.equal(b.hello.source, "real")
	assert.equal(f.started.length, 1)
})

test("real with no board falls back to the newest recording, as a replay", async () => {
	const root = tempDir()
	mkdirSync(join(root, "fixtures/bench"), { recursive: true })
	writeFileSync(join(root, "fixtures/bench/2026-10-31-a.jsonl"), "{}\n")
	writeFileSync(join(root, "fixtures/bench/2026-10-31-b.jsonl"), "{}\n")
	assert.equal(latestRecording(root), join(root, "fixtures/bench/2026-10-31-b.jsonl"))
	const f = fakeStart({ real: null })
	const logs: string[] = []
	const b = await openBench({ root, source: "real", outDir: "/out/r", start: f.start, log: (m) => logs.push(m) })
	assert.equal(b.hello.source, "replay")
	assert.deepEqual(f.closed, ["real"])
	assert.ok(f.started[1].includes(join(root, "fixtures/bench/2026-10-31-b.jsonl")))
	assert.match(logs.join("\n"), /no board.*replay/i)
})

test("real with no board and no recording falls back to the fake bench", async () => {
	const f = fakeStart({ real: null })
	const b = await openBench({ root: tempDir(), source: "real", outDir: "/out/r", start: f.start, log: () => {} })
	assert.equal(b.hello.source, "fake")
})

test("replay without a recording is an error, not a silent fake", async () => {
	const f = fakeStart({})
	await assert.rejects(openBench({ root: tempDir(), source: "replay", outDir: "/out/r", start: f.start, log: () => {} }), /recording/)
})
