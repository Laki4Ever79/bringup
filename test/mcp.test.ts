import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
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
	const raw = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args })
	return { call, raw, outRoot, close: () => client.close() }
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

test("a real-model run needs realModels: true and a configured provider; mock stays the free default", async (t) => {
	// Run plans go to the tools home: a temporary one here.
	const home = process.env.BRINGUP_HOME
	process.env.BRINGUP_HOME = tempDir()
	t.after(() => (home === undefined ? delete process.env.BRINGUP_HOME : (process.env.BRINGUP_HOME = home)))
	const stub = stubRun()
	const none = await connectWith({ launch: stub.launch, env: {} })
	try {
		assert.match((await none.call("start_design", { brief: "x", mock: false })).text, /pass realModels: true/)
		assert.match((await none.call("start_design", { brief: "x", mock: false, realModels: true })).text, /no AI is configured/)
		assert.match((await none.call("start_system", { system: "rover-pi", mock: false })).text, /pass realModels: true/)
		assert.equal(stub.calls.length, 0, "nothing launched")
	} finally {
		await none.close()
	}
	const keyed = await connectWith({ launch: stub.launch, env: { OPENAI_API_KEY: "set" } })
	try {
		// A real run starts from a plan the user approved (src/system/plan-gate.ts).
		assert.match((await keyed.call("start_design", { brief: "x", mock: false, realModels: true })).text, /approved plan: call plan_design/)
		const { planId } = (await keyed.call("plan_design", { brief: "x" })).json()
		assert.match((await keyed.call("start_design", { brief: "x", mock: false, realModels: true, planId })).text, /isn't approved yet/)
		await keyed.call("approve_plan", { planId })
		assert.match((await keyed.call("start_design", { brief: "y", mock: false, realModels: true, planId })).text, /different brief/)
		const r = await keyed.call("start_design", { brief: "x", mock: false, realModels: true, planId })
		assert.equal(r.isError, false, r.text)
		assert.equal(stub.calls[0].mock, false)
		assert.deepEqual(stub.calls[0].extraArgs, ["--plan", planId])
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
		// The finished examples ship with the private repo only (examples/ minus learn): list what this checkout has.
		const shipped = readdirSync("examples").filter((n) => existsSync(join("examples", n, "example.json")))
		assert.deepEqual(s.examples.map((e: { name: string }) => e.name).sort(), shipped.sort())
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
		// The overview the agent reads first: the flow, that mocks are free, and that installs need the user's yes.
		const instructions = client.getInstructions() ?? ""
		assert.match(instructions, /start_design[\s\S]*design_status[\s\S]*run_summary/)
		assert.match(instructions, /free/)
		assert.match(instructions, /ask the user first/)
		assert.deepEqual(names, ["approve_plan", "continue_design", "design_status", "export_package", "get_pictures", "get_report", "list_events", "list_part_refs", "list_starters", "plan_design", "read_contract", "request_change", "run_summary", "start_design", "start_system", "stop_design"])
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
	const bare = await connectWith({ launch: stub.launch, detect: async () => ({ tsci: null, python: null, pio: "pio" }), docker: async () => false })
	try {
		const r = (await bare.call("start_design", { brief: "x" })).json()
		// Builds what the tools allow (here firmware) and stubs the rest; says per domain what one command would add, how
		// big, and that the agent asks its user first (setup streamlining, 26 Nov 2026).
		assert.match(r.hardware, /^partly stubbed \(board, case\): this machine lacks tscircuit, Python with build123d and Docker\./)
		assert.match(r.hardware, /ask your user first, then either run `npx bringup-mcp setup board case` or start the design again with installTools: true: board: about 923 MB .*; case: about 945 MB/)
		assert.deepEqual(stub.calls[0].extraArgs, ["--stub-missing"])
		const b = (await bare.call("start_design", { brief: "x", hardware: "build" })).json()
		assert.match(b.hardware, /^built where the tools are \(asked\), stubbed where this machine lacks tscircuit, Python with build123d \(no Docker\)\./)
		assert.deepEqual(stub.calls[1].extraArgs, ["--stub-missing"])
		stub.release()
	} finally {
		await bare.close()
	}
})

test("hardware auto builds in Docker where the tools are missing and Docker works, and says so", async () => {
	const stub = stubRun()
	const bare = await connectWith({ launch: stub.launch, detect: async () => ({ tsci: null, python: null, pio: null, kicad: null }), docker: async () => true })
	const ready = await connectWith({ launch: stub.launch, detect: async () => ({ tsci: "/s/tsci", python: "/s/python", pio: "/s/pio", kicad: "docker", toolchain: { image: "bringup-toolchain:abc", tools: ["tsci", "python", "pio"] } }), docker: async () => true })
	try {
		const r = (await bare.call("start_design", { brief: "x" })).json()
		assert.match(r.hardware, /^built in Docker: this machine lacks tscircuit, Python with build123d, PlatformIO, KiCad, so they run in Bringup's toolchain image/)
		assert.deepEqual(stub.calls[0].extraArgs, ["--docker-toolchain"])
		const again = (await ready.call("start_design", { brief: "x" })).json()
		assert.equal(again.hardware, "built (tsci, python, pio in Docker, bringup-toolchain:abc)")
		assert.equal(stub.calls[1].extraArgs, undefined)
		stub.release()
	} finally {
		await bare.close()
		await ready.close()
	}
})

test("a system run's tools read each board's folder: status per board, contract, report, events, package", async () => {
	const outRoot = tempDir()
	const runDir = join(outRoot, "sys-1")
	for (const [name, settled] of [["main", true], ["rpi-5-carrier", false]] as const) {
		const dir = join(runDir, "boards", name)
		mkdirSync(dir, { recursive: true })
		const lines = trace.map((l) => (l.type === "design.settled" ? { ...l, payload: { ...l.payload, settled } } : l))
		writeFileSync(join(dir, "trace.jsonl"), lines.map((l) => JSON.stringify(l) + "\n").join(""))
		writeFileSync(join(dir, "contract.json"), JSON.stringify(fixtureContract()))
		writeFileSync(join(dir, "report.md"), `# ${name}\n`)
	}
	const launches: LaunchArgs[] = []
	const mcp = await connectWith({ outRoot, launch: (args) => (launches.push(args), { done: Promise.resolve({ code: 3, stderr: "bringup: not packaged: the design isn't finished:\n  - x\nFix these and rerun, or pass --force to package it anyway." }) }) })
	try {
		const all = (await mcp.call("design_status", { runId: "sys-1" })).json()
		assert.equal(all.status, "unsettled")
		assert.deepEqual(all.boards.map((b: any) => [b.board, b.status, b.revision, b.counts.events]), [["main", "settled", 4, 5], ["rpi-5-carrier", "unsettled", 4, 5]])
		assert.equal((await mcp.call("design_status", { runId: "sys-1", board: "main" })).json().status, "settled")
		assert.equal((await mcp.call("get_report", { runId: "sys-1", board: "rpi-5-carrier" })).text, "# rpi-5-carrier\n")
		assert.equal((await mcp.call("read_contract", { runId: "sys-1" })).isError, false)
		assert.equal((await mcp.call("list_events", { runId: "sys-1", board: "main" })).json().events.length, 5)
		assert.match((await mcp.call("read_contract", { runId: "sys-1", board: "arm" })).text, /has no board arm/)
		const pkg = await mcp.call("export_package", { runId: "sys-1", board: "rpi-5-carrier" })
		assert.equal(pkg.isError, true)
		assert.match(pkg.text, /pass force: true/)
		assert.doesNotMatch(pkg.text, /--force/)
		assert.equal(launches[0].outDir, join(runDir, "boards", "rpi-5-carrier"))
	} finally {
		await mcp.close()
	}
})

test("server.json passes the MCP registry's limits and matches package.json", () => {
	const server = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"))
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
	// The registry rejects a description over 100 characters (the 0.2.0 publish had to shorten it by hand).
	assert.ok(server.description.length <= 100, `server.json description is ${server.description.length} characters; the registry takes 100`)
	assert.equal(server.name, pkg.mcpName)
	assert.equal(server.version, pkg.version)
	assert.ok(server.packages.every((p: any) => p.identifier !== pkg.name || p.version === pkg.version))
})

test("a run kept up with stay reports settled (staying) once its latest revision settles", async () => {
	const launch: Launch = (args) => {
		writeFileSync(join(args.outDir, "trace.jsonl"), trace.map((l) => JSON.stringify(l) + "\n").join(""))
		return { done: new Promise(() => {}), kill: () => {} }
	}
	const mcp = await connect(launch)
	try {
		const { runId } = (await mcp.call("start_design", { brief: "x", stay: true })).json()
		const s = (await mcp.call("design_status", { runId })).json()
		assert.equal(s.status, "settled")
		assert.equal(s.staying, true)
		assert.equal(s.settledAt, undefined)
		// A change moves the contract past the settle: running again until the new revision settles.
		const more = { seq: 5, at: "2026-10-30T12:00:05.000Z", type: "contract.changed", producerId: "architect", payload: { field: "outline", version: 2, revision: 5, by: "engineer" } }
		writeFileSync(join(mcp.outRoot, runId, "trace.jsonl"), [...trace, more].map((l) => JSON.stringify(l) + "\n").join(""))
		assert.equal((await mcp.call("design_status", { runId })).json().status, "running")
		// Without stay, a live process stays "running".
		const plain = (await mcp.call("start_design", { brief: "y" })).json()
		assert.equal((await mcp.call("design_status", { runId: plain.runId })).json().status, "running")
	} finally {
		await mcp.close()
	}
})

test("a system with no board named main: status lists its boards and the other tools name them", async () => {
	const mcp = await connect(stubRun().launch)
	try {
		const runDir = join(mcp.outRoot, "sys-run")
		for (const name of ["beacon", "logger"]) {
			mkdirSync(join(runDir, "boards", name), { recursive: true })
			writeFileSync(join(runDir, "boards", name, "trace.jsonl"), trace.map((l) => JSON.stringify(l) + "\n").join(""))
		}
		const all = (await mcp.call("design_status", { runId: "sys-run" })).json()
		assert.deepEqual(all.boards.map((b: any) => b.board), ["beacon", "logger"])
		assert.equal(all.status, "settled")
		assert.match((await mcp.call("read_contract", { runId: "sys-run" })).text, /is a system: pass board, one of beacon, logger/)
		assert.equal((await mcp.call("design_status", { runId: "sys-run", board: "logger" })).json().revision, 4)
	} finally {
		await mcp.close()
	}
})

test("installTools: the missing domains install first (the call returns at once), then the run starts with them", async () => {
	const stub = stubRun()
	let tools = { tsci: null as string | null, python: null as string | null, pio: "pio" as string | null }
	const installed: string[] = []
	let finish: () => void = () => {}
	const gate = new Promise<void>((r) => (finish = r))
	const c = await connectWith({
		launch: stub.launch,
		detect: async () => tools,
		docker: async () => false,
		install: async (d) => {
			await gate
			installed.push(d)
			tools = { ...tools, ...(d === "board" ? { tsci: "/h/tsci" } : { python: "/h/python" }) }
			return { installed: true, note: `${d} tools in ~/.bringup` }
		},
	})
	try {
		const r = (await c.call("start_design", { brief: "x", installTools: true })).json()
		assert.match(r.hardware, /^installing board: about 923 MB .*; case: about 945 MB .*; the run starts when that's done/)
		assert.equal((await c.call("design_status", { runId: r.runId })).json().status, "installing")
		assert.equal(stub.calls.length, 0, "nothing runs before the tools are in")
		finish()
		await until(async () => stub.calls.length === 1)
		assert.deepEqual(installed, ["board", "case"])
		assert.deepEqual(stub.calls[0].extraArgs, undefined) // everything is there now: nothing stubbed
		assert.match(readFileSync(join(r.outDir, "setup.log"), "utf8"), /board: board tools in ~\/\.bringup\ncase: case tools/)
		stub.release()
	} finally {
		await c.close()
	}
})

test("continue_design starts a new run from an ended one's contract (latest or a revision); real models need the plan gate", async () => {
	const outRoot = tempDir()
	const old = join(outRoot, "old-run")
	mkdirSync(join(old, "contracts"), { recursive: true })
	writeFileSync(join(old, "trace.jsonl"), trace.map((l) => JSON.stringify(l) + "\n").join(""))
	writeFileSync(join(old, "brief.md"), "BLE temperature logger\n")
	writeFileSync(join(old, "contract.json"), JSON.stringify(fixtureContract()))
	writeFileSync(join(old, "contracts", "rev-2.json"), JSON.stringify({ ...fixtureContract(), revision: 2 }))
	const stub = stubRun()
	const mcp = await connect(stub.launch, outRoot)
	try {
		const res = (await mcp.call("continue_design", { runId: "old-run" })).json()
		assert.equal(res.continuedFrom, "old-run")
		assert.equal(res.mock, true)
		assert.equal(res.stay, true)
		const args = stub.calls.at(-1)!
		assert.equal(args.briefPath, "continue")
		assert.deepEqual(args.extraArgs?.slice(0, 2), ["--from", old])
		assert.ok(args.extraArgs?.includes("--stay"))
		assert.notEqual(args.outDir, old)
		const branched = (await mcp.call("continue_design", { runId: "old-run", revision: 2 })).json()
		assert.equal(branched.revision, 2)
		assert.deepEqual(stub.calls.at(-1)!.extraArgs?.slice(2, 4), ["--rev", "2"])
		assert.match((await mcp.call("continue_design", { runId: "old-run", revision: 9 })).text, /no revision 9/)
		const paid = await mcp.call("continue_design", { runId: "old-run", mock: false })
		assert.equal(paid.isError, true)
		stub.release()
	} finally {
		await mcp.close()
	}
})

test("get_pictures returns the newest board's 3D picture as an image and lists every picture by path", async () => {
	const outRoot = tempDir()
	const dir = join(outRoot, "pics-run")
	for (const rev of [2, 3]) mkdirSync(join(dir, "board", `rev-${rev}`), { recursive: true })
	mkdirSync(join(dir, "enclosure", "rev-3"), { recursive: true })
	writeFileSync(join(dir, "trace.jsonl"), trace.map((l) => JSON.stringify(l) + "\n").join(""))
	const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")
	writeFileSync(join(dir, "board", "rev-2", "board.png"), png)
	writeFileSync(join(dir, "board", "rev-3", "board.png"), png)
	writeFileSync(join(dir, "board", "rev-3", "board-pcb.svg"), "<svg/>")
	writeFileSync(join(dir, "enclosure", "rev-3", "case.stl"), "solid case")
	const mcp = await connect(stubRun().launch, outRoot)
	try {
		const result: any = await mcp.raw("get_pictures", { runId: "pics-run" })
		const listed = JSON.parse(result.content[0].text)
		assert.deepEqual(listed.files.map((f: any) => f.path), [join(dir, "board", "rev-3", "board.png"), join(dir, "board", "rev-3", "board-pcb.svg"), join(dir, "enclosure", "rev-3", "case.stl")])
		assert.equal(result.content[1].type, "image")
		assert.equal(result.content[1].mimeType, "image/png")
		assert.equal(result.content[1].data, png.toString("base64"))
		// A design with no board built says how to get one; stills without a robot or arm say why there are none.
		mkdirSync(join(outRoot, "bare"))
		writeFileSync(join(outRoot, "bare", "trace.jsonl"), trace.map((l) => JSON.stringify(l) + "\n").join(""))
		const bare = JSON.parse((await mcp.call("get_pictures", { runId: "bare", stills: true })).text)
		assert.deepEqual(bare.files, [])
		assert.match(bare.notes.join(" "), /setup board/)
		assert.match(bare.notes.join(" "), /a case, a robot's chassis or an arm/)
	} finally {
		await mcp.close()
	}
})
