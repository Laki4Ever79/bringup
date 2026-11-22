import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createBringupMcpServer } from "../src/mcp/server.ts"
import { fixtureContract } from "./fixture.ts"
import { slow, tempDir } from "./helpers.ts"

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

async function connect(launch: Launch, outRoot = tempDir()) {
	const server = createBringupMcpServer({ launch, outRoot, detect: async () => ({ tsci: "tsci", python: "python", pio: "pio" }) })
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
	const outRoot = tempDir()
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

test("design_status counts approved and rejected from change.resolved, not from votes", async () => {
	const outRoot = tempDir()
	mkdirSync(join(outRoot, "voted"))
	const t = [
		{ seq: 0, at: "", type: "change.proposed", producerId: "f", payload: { proposalId: "p1", field: "pins", by: "firmware", reason: "", needsEngineer: true } },
		{ seq: 1, at: "", type: "change.decided", producerId: "a", payload: { proposalId: "p1", approved: true, by: "architect", reason: "ok" } },
		{ seq: 2, at: "", type: "change.decided", producerId: "e", payload: { proposalId: "p1", approved: false, by: "engineer", reason: "no" } },
		{ seq: 3, at: "", type: "change.resolved", producerId: "d", payload: { proposalId: "p1", approved: false, reason: "no", decidedBy: ["architect", "engineer"] } },
	]
	writeFileSync(join(outRoot, "voted", "trace.jsonl"), t.map((l) => JSON.stringify(l) + "\n").join(""))
	const mcp = await connect(stubRun().launch, outRoot)
	try {
		const { counts } = (await mcp.call("design_status", { runId: "voted" })).json()
		assert.deepEqual({ proposed: counts.proposed, approved: counts.approved, rejected: counts.rejected }, { proposed: 1, approved: 0, rejected: 1 })
	} finally {
		await mcp.close()
	}
})

// ── The publishable server (22 Nov 2026, "We should also publish an MCP"): safe defaults, systems, summaries,
// part references, packages, and the npx entry point over real stdio.

async function connectWith(deps: Partial<Parameters<typeof createBringupMcpServer>[0]> & { launch: Launch }) {
	const server = createBringupMcpServer({ outRoot: tempDir(), detect: async () => ({ tsci: "tsci", python: "python", pio: "pio" }), ...deps })
	const [a, b] = InMemoryTransport.createLinkedPair()
	const client = new Client({ name: "test", version: "0" })
	await Promise.all([server.connect(a), client.connect(b)])
	const call = async (name: string, args: Record<string, unknown>) => {
		const res: any = await client.callTool({ name, arguments: args })
		const text = res.content?.[0]?.text ?? ""
		return { isError: res.isError === true, text, json: () => JSON.parse(text) }
	}
	return { call, close: () => client.close() }
}

test("a real-model run needs realModels: true and a configured provider; mock stays the free default", async () => {
	const stub = stubRun()
	const none = await connectWith({ launch: stub.launch, env: {} })
	try {
		assert.match((await none.call("start_design", { brief: "x", mock: false })).text, /pass realModels: true/)
		assert.match((await none.call("start_design", { brief: "x", mock: false, realModels: true })).text, /no model provider is configured/)
		assert.match((await none.call("start_system", { system: "rover-pi", mock: false })).text, /pass realModels: true/)
		assert.equal(stub.calls.length, 0, "nothing launched")
	} finally {
		await none.close()
	}
	const keyed = await connectWith({ launch: stub.launch, env: { OPENAI_API_KEY: "set" } })
	try {
		const r = await keyed.call("start_design", { brief: "x", mock: false, realModels: true })
		assert.equal(r.isError, false, r.text)
		assert.equal(stub.calls[0].mock, false)
		stub.release()
	} finally {
		await keyed.close()
	}
})

test("stay keeps a run up for changes and stop_design ends it", async () => {
	let killed = 0
	const launch: Launch = (args) => ({ done: new Promise(() => {}), kill: () => { killed++ } , ...(void args, {}) })
	const calls: LaunchArgs[] = []
	const mcp = await connectWith({ launch: (a) => (calls.push(a), launch(a)) })
	try {
		const { runId } = (await mcp.call("start_design", { brief: "x", stay: true })).json()
		assert.deepEqual(calls[0].extraArgs, ["--stay"])
		assert.equal((await mcp.call("stop_design", { runId })).isError, false)
		assert.equal(killed, 1)
		assert.match((await mcp.call("stop_design", { runId: "nope" })).text, /wasn't started by this server/)
	} finally {
		await mcp.close()
	}
})

test("start_system takes a bundled system by name or a spec, mock by default", async () => {
	const stub = stubRun()
	const mcp = await connectWith({ launch: stub.launch })
	try {
		const r = await mcp.call("start_system", { system: "rover-pi" })
		assert.equal(r.isError, false, r.text)
		assert.equal(stub.calls[0].briefPath, "system")
		assert.match(stub.calls[0].extraArgs![0], /briefs\/systems\/rover-pi\.json$/)
		assert.deepEqual(stub.calls[0].extraArgs!.slice(1), ["--mock"])
		assert.match((await mcp.call("start_system", { system: "../etc" })).text, /no bundled system/)
		const spec = { name: "two boards", boards: [{ name: "a", brief: "x" }], links: [] }
		const s = (await mcp.call("start_system", { system: spec })).json()
		assert.deepEqual(JSON.parse(readFileSync(join(s.outDir, "system-spec.json"), "utf8")), spec)
		stub.release()
	} finally {
		await mcp.close()
	}
})

test("list_starters names the shipped examples, systems and briefs", async () => {
	const mcp = await connectWith({ launch: stubRun().launch })
	try {
		const s = (await mcp.call("list_starters", {})).json()
		assert.ok(s.examples.some((e: { name: string }) => e.name === "rover"))
		assert.ok(s.systems.some((e: { name: string }) => e.name === "rover-climate"))
		assert.ok(s.briefs.some((e: { name: string }) => e.name === "rover"))
	} finally {
		await mcp.close()
	}
})

test("run_summary gives each artifact's own verdict; a part ref goes before the change request", async () => {
	const outRoot = tempDir()
	const dir = join(outRoot, "r1")
	mkdirSync(join(dir, "chassis", "rev-3"), { recursive: true })
	writeFileSync(join(dir, "trace.jsonl"), "")
	writeFileSync(join(dir, "report.md"), "# Bringup report\n\nStatus: UNSETTLED at contract revision 3\nModels: mock\nViolations: 1\n- mech-climb: the caster carries 44 %\n\n## Design\n")
	writeFileSync(join(dir, "chassis", "rev-3", "mounts.json"), JSON.stringify({ interference: { pairs: 28, clashes: [], unmeasured: [] } }))
	writeFileSync(join(dir, "chassis", "rev-3", "refs.json"), JSON.stringify([{ ref: "chassis#sensor-bracket", kind: "sensor-bracket", label: "the distance sensor's bracket", atMm: [70, 0, 15], madeBy: "py/chassis.py:220 build" }]))
	const mcp = await connectWith({ launch: stubRun().launch, outRoot })
	try {
		const s = (await mcp.call("run_summary", { runId: "r1" })).json()
		assert.equal(s.status, "UNSETTLED at contract revision 3")
		assert.match(s.text, /! mech-climb: the caster carries 44 %/)
		assert.match(s.text, /chassis \(rev 3\): interference: 28 pairs, 0 clash\(es\), 0 unmeasured/)
		const refs = (await mcp.call("list_part_refs", { runId: "r1" })).json()
		assert.deepEqual(refs.chassis.map((r: { ref: string }) => r.ref), ["chassis#sensor-bracket"])
		assert.equal((await mcp.call("request_change", { runId: "r1", text: "make it 2 mm thicker", ref: "chassis#sensor-bracket" })).isError, false)
		const line = JSON.parse(readFileSync(join(dir, "requests.jsonl"), "utf8").trim())
		assert.equal(line.text, "[chassis#sensor-bracket: the distance sensor's bracket; made by py/chassis.py:220 build] make it 2 mm thicker")
		assert.match((await mcp.call("request_change", { runId: "r1", text: "x", ref: "chassis#nope" })).text, /no part chassis#nope/)
	} finally {
		await mcp.close()
	}
})

// The npx entry point itself, over real stdio: the handshake, the tool list and a refused paid run (nothing launched).
test("bin/bringup-mcp.js speaks MCP on stdio: handshake, every tool listed, safe defaults", async () => {
	const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js")
	const root = join(import.meta.dirname, "..")
	const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, "bin", "bringup-mcp.js")], env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", BRINGUP_OUT: tempDir() }, stderr: "pipe" })
	const client = new Client({ name: "stdio-test", version: "0" })
	await client.connect(transport)
	try {
		assert.equal(client.getServerVersion()?.name, "bringup")
		const names = (await client.listTools()).tools.map((t) => t.name).sort()
		assert.deepEqual(names, ["design_status", "export_package", "get_report", "list_events", "list_part_refs", "list_starters", "read_contract", "request_change", "run_summary", "start_design", "start_system", "stop_design"])
		const refused: any = await client.callTool({ name: "start_design", arguments: { brief: "x", mock: false } })
		assert.equal(refused.isError, true)
	} finally {
		await client.close()
	}
})

// One whole mock design through the npx entry point (minutes; the machine's heavy-job slot).
test("over stdio, a mock design runs to the end and run_summary reports it", { skip: slow, timeout: 1_800_000 }, async () => {
	const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js")
	const root = join(import.meta.dirname, "..")
	const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, "bin", "bringup-mcp.js")], env: { ...(process.env as Record<string, string>), BRINGUP_OUT: tempDir(), MOZAIK_API_KEY: "", MOZAIK_CREDENTIALS_FILE: "/dev/null" }, stderr: "pipe" })
	const client = new Client({ name: "stdio-test", version: "0" })
	await client.connect(transport)
	const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })) as any).content[0].text)
	try {
		const { runId } = await call("start_design", { brief: readFileSync(join(root, "briefs", "logger.md"), "utf8") })
		let status = "running"
		for (let i = 0; i < 340 && status === "running"; i++) {
			await new Promise((r) => setTimeout(r, 5000))
			status = (await call("design_status", { runId })).status
		}
		assert.ok(status === "settled" || status === "unsettled", status)
		const s = await call("run_summary", { runId })
		assert.match(s.text, /board \(rev \d+\)/)
	} finally {
		await client.close()
	}
})

test("hardware auto builds where the toolchain is and stubs where it isn't, and says which", async () => {
	const stub = stubRun()
	const bare = await connectWith({ launch: stub.launch, detect: async () => ({ tsci: null, python: null, pio: "pio" }) })
	try {
		const r = (await bare.call("start_design", { brief: "x" })).json()
		assert.match(r.hardware, /stubbed: this machine lacks tscircuit, Python with build123d/)
		assert.deepEqual(stub.calls[0].extraArgs, ["--no-hardware"])
		const b = (await bare.call("start_design", { brief: "x", hardware: "build" })).json()
		assert.equal(b.hardware, "built")
		assert.equal(stub.calls[1].extraArgs, undefined)
		stub.release()
	} finally {
		await bare.close()
	}
})
