import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBringupMcpServer } from "../src/mcp/server.ts"
import { fixtureContract } from "./fixture.ts"

const trace = [
	{ seq: 0, at: "2026-10-30T12:00:00.000Z", type: "contract.changed", producerId: "architect", payload: { field: "outline", version: 1, revision: 1, by: "architect" } },
	{ seq: 1, at: "2026-10-30T12:00:01.000Z", type: "change.proposed", producerId: "firmware", payload: { proposalId: "p1", field: "pins", by: "firmware", reason: "move SDA" } },
	{ seq: 2, at: "2026-10-30T12:00:02.000Z", type: "change.decided", producerId: "architect", payload: { proposalId: "p1", approved: true, by: "architect", reason: "ok" } },
	{ seq: 3, at: "2026-10-30T12:00:03.000Z", type: "consistency.checked", producerId: "consistency", payload: { revision: 4, violations: [] } },
	{ seq: 4, at: "2026-10-30T12:00:04.000Z", type: "design.settled", producerId: "consistency", payload: { revision: 4, settled: true } },
]

type Launch = Parameters<typeof createBringupMcpServer>[0]["launch"]
type LaunchArgs = Parameters<Launch>[0]

// Stub launch: writes the run files like `tsx src/main.ts` would, but only once `release()` is called.
function stubRun() {
	const gates: (() => void)[] = []
	const calls: LaunchArgs[] = []
	const launch: Launch = (args) => {
		calls.push(args)
		writeFileSync(join(args.outDir, "trace.jsonl"), trace.slice(0, 2).map((l) => JSON.stringify(l) + "\n").join(""))
		const done = new Promise<void>((ok) => gates.push(ok)).then(() => {
			writeFileSync(join(args.outDir, "trace.jsonl"), trace.map((l) => JSON.stringify(l) + "\n").join(""))
			writeFileSync(join(args.outDir, "contract.json"), JSON.stringify(fixtureContract()))
			writeFileSync(join(args.outDir, "report.md"), "# Report\n\nsettled at revision 4\n")
			return { code: 0, stderr: "" }
		})
		return { done }
	}
	return { launch, calls, release: () => gates.splice(0).forEach((g) => g()) }
}

const exitWith = (code: number, stderr: string): Launch => () => ({ done: Promise.resolve({ code, stderr }) })

async function connect(launch: Launch, outRoot = mkdtempSync(join(tmpdir(), "bringup-mcp-"))) {
	const server = createBringupMcpServer({ launch, outRoot })
	const [a, b] = InMemoryTransport.createLinkedPair()
	const client = new Client({ name: "test", version: "0" })
	await Promise.all([server.connect(a), client.connect(b)])
	const call = async (name: string, args: Record<string, unknown>) => {
		const res: any = await client.callTool({ name, arguments: args })
		const text = res.content?.[0]?.text ?? ""
		return { isError: res.isError === true, text, json: () => JSON.parse(text) }
	}
	return { call, outRoot, close: () => client.close() }
}

async function until(check: () => Promise<boolean>, ms = 2000) {
	const end = Date.now() + ms
	while (!(await check())) {
		if (Date.now() > end) throw new Error("timed out")
		await new Promise((r) => setTimeout(r, 10))
	}
}

test("start_design returns a runId before the run finishes", async () => {
	const stub = stubRun()
	const mcp = await connect(stub.launch)
	try {
		const res = await mcp.call("start_design", { brief: "BLE temperature logger", mock: true })
		assert.equal(res.isError, false, res.text)
		const { runId, outDir } = res.json()
		assert.match(runId, /^[\w-]+$/)
		assert.equal(outDir, join(mcp.outRoot, runId))
		assert.equal(stub.calls.length, 1)
		assert.deepEqual(stub.calls[0], { briefPath: join(outDir, "brief.md"), mock: true, outDir })
		assert.equal(readFileSync(join(outDir, "brief.md"), "utf8"), "BLE temperature logger\n")
		stub.release()
	} finally {
		await mcp.close()
	}
})

test("design_status moves from running to settled", async () => {
	const stub = stubRun()
	const mcp = await connect(stub.launch)
	try {
		const { runId } = (await mcp.call("start_design", { brief: "logger" })).json()
		const running = (await mcp.call("design_status", { runId })).json()
		assert.equal(running.status, "running")
		assert.equal(running.counts.proposed, 1)

		stub.release()
		await until(async () => (await mcp.call("design_status", { runId })).json().status === "settled")
		const done = (await mcp.call("design_status", { runId })).json()
		assert.equal(done.revision, 4)
		assert.deepEqual(done.violations, [])
		assert.deepEqual({ proposed: done.counts.proposed, approved: done.counts.approved, rejected: done.counts.rejected }, { proposed: 1, approved: 1, rejected: 0 })
	} finally {
		await mcp.close()
	}
})

test("a run that exits 1 reports failed with its stderr tail", async () => {
	const mcp = await connect(exitWith(1, "starting\nError: kicad image missing\n"))
	try {
		const { runId } = (await mcp.call("start_design", { brief: "logger" })).json()
		await until(async () => (await mcp.call("design_status", { runId })).json().status === "failed")
		assert.match((await mcp.call("design_status", { runId })).json().error, /kicad image missing/)
	} finally {
		await mcp.close()
	}
})

test("read_contract, get_report and list_events read the run files", async () => {
	const stub = stubRun()
	const mcp = await connect(stub.launch)
	try {
		const { runId } = (await mcp.call("start_design", { brief: "logger" })).json()
		stub.release()
		await until(async () => (await mcp.call("design_status", { runId })).json().status === "settled")

		assert.deepEqual((await mcp.call("read_contract", { runId })).json(), fixtureContract())
		assert.match((await mcp.call("get_report", { runId })).text, /settled at revision 4/)
		const events = (await mcp.call("list_events", { runId, sinceSeq: 2 })).json()
		assert.deepEqual(events.events.map((e: any) => e.seq), [3, 4])
		assert.equal((await mcp.call("list_events", { runId })).json().events.length, 5)
	} finally {
		await mcp.close()
	}
})

test("an existing run dir under outRoot is readable", async () => {
	const outRoot = mkdtempSync(join(tmpdir(), "bringup-mcp-"))
	mkdirSync(join(outRoot, "old-run"))
	writeFileSync(join(outRoot, "old-run", "trace.jsonl"), trace.map((l) => JSON.stringify(l) + "\n").join(""))
	const mcp = await connect(stubRun().launch, outRoot)
	try {
		const status = (await mcp.call("design_status", { runId: "old-run" })).json()
		assert.equal(status.status, "settled")
		const missing = await mcp.call("read_contract", { runId: "old-run" })
		assert.equal(missing.isError, true)
	} finally {
		await mcp.close()
	}
})

test("unknown and path-like runIds give an error result, not a crash", async () => {
	const mcp = await connect(stubRun().launch)
	try {
		for (const runId of ["nope", "../x", "..", "a/b", "/etc", ""]) {
			for (const tool of ["design_status", "read_contract", "get_report", "list_events"]) {
				const res = await mcp.call(tool, { runId })
				assert.equal(res.isError, true, `${tool}(${JSON.stringify(runId)}) → ${res.text}`)
			}
		}
		// The server still answers afterwards.
		assert.equal((await mcp.call("start_design", { brief: "x" })).isError, false)
	} finally {
		await mcp.close()
	}
})

test("exit code 2 means unsettled", async () => {
	const mcp = await connect(exitWith(2, ""))
	try {
		const { runId } = (await mcp.call("start_design", { brief: "logger" })).json()
		await until(async () => (await mcp.call("design_status", { runId })).json().status === "unsettled")
	} finally {
		await mcp.close()
	}
})

test("start_design defaults to mock", async () => {
	const stub = stubRun()
	const mcp = await connect(stub.launch)
	try {
		await mcp.call("start_design", { brief: "logger" })
		assert.equal(stub.calls[0].mock, true)
		stub.release()
	} finally {
		await mcp.close()
	}
})

test("two overlapping runs both settle in separate outDirs", async () => {
	const stub = stubRun()
	const mcp = await connect(stub.launch)
	try {
		const [a, b] = await Promise.all([
			mcp.call("start_design", { brief: "logger A" }).then((r) => r.json()),
			mcp.call("start_design", { brief: "logger B" }).then((r) => r.json()),
		])
		assert.notEqual(a.runId, b.runId)
		assert.notEqual(a.outDir, b.outDir)
		assert.equal(stub.calls.length, 2)
		for (const r of [a, b]) assert.equal((await mcp.call("design_status", { runId: r.runId })).json().status, "running")
		assert.equal(readFileSync(join(a.outDir, "brief.md"), "utf8"), "logger A\n")
		assert.equal(readFileSync(join(b.outDir, "brief.md"), "utf8"), "logger B\n")

		stub.release()
		for (const r of [a, b]) await until(async () => (await mcp.call("design_status", { runId: r.runId })).json().status === "settled")
	} finally {
		await mcp.close()
	}
})

test("request_change appends a line to the run's requests.jsonl", async () => {
	const stub = stubRun()
	const mcp = await connect(stub.launch)
	try {
		const { runId, outDir } = (await mcp.call("start_design", { brief: "logger" })).json()
		const res = await mcp.call("request_change", { runId, text: "make it 60 mm wide" })
		assert.equal(res.isError, false, res.text)
		await mcp.call("request_change", { runId, text: "move USB-C to the right" })
		const lines = readFileSync(join(outDir, "requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
		assert.deepEqual(lines.map((l) => l.text), ["make it 60 mm wide", "move USB-C to the right"])
		assert.ok(!Number.isNaN(Date.parse(lines[0].at)))
		stub.release()
	} finally {
		await mcp.close()
	}
})

test("request_change with a bad runId is an error result", async () => {
	const mcp = await connect(stubRun().launch)
	try {
		for (const runId of ["nope", "../x", ".."]) {
			const res = await mcp.call("request_change", { runId, text: "make it 60 mm wide" })
			assert.equal(res.isError, true, `${runId} → ${res.text}`)
		}
	} finally {
		await mcp.close()
	}
})
