import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBringupMcpServer } from "../src/mcp/server.ts"
import type { RunOptions, RunResult } from "../src/run.ts"
import { fixtureContract } from "./fixture.ts"

const trace = [
	{ seq: 0, at: "2026-10-30T12:00:00.000Z", type: "contract.changed", producerId: "architect", payload: { field: "outline", version: 1, revision: 1, by: "architect" } },
	{ seq: 1, at: "2026-10-30T12:00:01.000Z", type: "change.proposed", producerId: "firmware", payload: { proposalId: "p1", field: "pins", by: "firmware", reason: "move SDA" } },
	{ seq: 2, at: "2026-10-30T12:00:02.000Z", type: "change.decided", producerId: "architect", payload: { proposalId: "p1", approved: true, by: "architect", reason: "ok" } },
	{ seq: 3, at: "2026-10-30T12:00:03.000Z", type: "consistency.checked", producerId: "consistency", payload: { revision: 4, violations: [] } },
	{ seq: 4, at: "2026-10-30T12:00:04.000Z", type: "design.settled", producerId: "consistency", payload: { revision: 4, settled: true } },
]

// Stub run: writes the run files, then waits for `release()` before resolving.
function stubRun() {
	let release!: () => void
	const gate = new Promise<void>((ok) => (release = ok))
	const calls: RunOptions[] = []
	const runDesign = async (opts: RunOptions): Promise<RunResult> => {
		calls.push(opts)
		writeFileSync(join(opts.outDir, "trace.jsonl"), trace.slice(0, 2).map((l) => JSON.stringify(l) + "\n").join(""))
		await gate
		writeFileSync(join(opts.outDir, "trace.jsonl"), trace.map((l) => JSON.stringify(l) + "\n").join(""))
		writeFileSync(join(opts.outDir, "contract.json"), JSON.stringify(fixtureContract()))
		writeFileSync(join(opts.outDir, "report.md"), "# Report\n\nsettled at revision 4\n")
		return { settled: true, outDir: opts.outDir, revision: 4, violations: [], reportPath: join(opts.outDir, "report.md") }
	}
	return { runDesign, release, calls }
}

async function connect(runDesign: (o: RunOptions) => Promise<RunResult>, outRoot = mkdtempSync(join(tmpdir(), "bringup-mcp-"))) {
	const server = createBringupMcpServer({ runDesign, outRoot })
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
	const mcp = await connect(stub.runDesign)
	try {
		const res = await mcp.call("start_design", { brief: "BLE temperature logger", mock: true })
		assert.equal(res.isError, false, res.text)
		const { runId, outDir } = res.json()
		assert.match(runId, /^[\w-]+$/)
		assert.equal(outDir, join(mcp.outRoot, runId))
		assert.equal(stub.calls.length, 1)
		assert.deepEqual({ brief: stub.calls[0].brief, mock: stub.calls[0].mock, outDir: stub.calls[0].outDir }, { brief: "BLE temperature logger", mock: true, outDir })
		stub.release()
	} finally {
		await mcp.close()
	}
})

test("design_status moves from running to settled", async () => {
	const stub = stubRun()
	const mcp = await connect(stub.runDesign)
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

test("a run that throws reports failed with its error", async () => {
	const mcp = await connect(async () => {
		throw new Error("kicad image missing")
	})
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
	const mcp = await connect(stub.runDesign)
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
	const mcp = await connect(stubRun().runDesign, outRoot)
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
	const mcp = await connect(stubRun().runDesign)
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
