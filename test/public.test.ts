import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serveHub, type HubLaunch } from "../src/dashboard/server.ts"
import { PUBLIC_BANNER, PUBLIC_RUNS, PublicGate, preparePublicRoot } from "../src/dashboard/public.ts"

const HOUR = 3_600_000

test("the gate: one live run at a time, at most 5 runs per IP per hour", () => {
	let now = 0
	const gate = new PublicGate({ now: () => now })
	assert.equal(gate.admit("1.1.1.1"), null)
	assert.match(gate.admit("2.2.2.2")!.error, /a live run is already going/)
	assert.equal(gate.admit("2.2.2.2")!.status, 409)
	gate.finished()
	for (let i = 1; i < 5; i++) {
		assert.equal(gate.admit("1.1.1.1"), null, `run ${i + 1}`)
		gate.finished()
	}
	const sixth = gate.admit("1.1.1.1")!
	assert.equal(sixth.status, 429)
	assert.match(sixth.error, /5 runs an hour/)
	assert.equal(gate.admit("2.2.2.2"), null, "another IP still gets one")
	gate.finished()
	now += HOUR + 1
	assert.equal(gate.admit("1.1.1.1"), null, "an hour later the IP may run again")
})

test("the gate: one typed change per run, only from the scripted set", () => {
	const gate = new PublicGate()
	assert.match(gate.change("r1", "rm -rf /")!.error, /scripted changes/)
	assert.equal(gate.change("r1", "add a temperature/humidity sensor"), null)
	assert.equal(gate.change("r1", "make it 40 mm wide")!.status, 409)
	assert.equal(gate.change("r2", "make it 40 mm wide"), null)
	assert.equal(gate.change("r3", "blink faster when tilted"), null)
	assert.equal(gate.change("r4", "x".repeat(200))!.status, 400)
})

test("the recorded runs are copied from docs/runs into the public out root", () => {
	const root = mkdtempSync(join(tmpdir(), "bringup-public-"))
	const copied = preparePublicRoot(root)
	assert.ok(copied.includes("add-sensor") && copied.includes("real-20"), copied.join(" "))
	for (const id of copied) assert.ok(existsSync(join(root, id, "trace.jsonl")), id)
	assert.ok(copied.every((id) => PUBLIC_RUNS.includes(id)))
})

function publicRoot() {
	const root = mkdtempSync(join(tmpdir(), "bringup-public-"))
	mkdirSync(join(root, "add-sensor"))
	writeFileSync(join(root, "add-sensor", "trace.jsonl"), JSON.stringify({ seq: 0, at: "2026-10-31T12:00:00.000Z", type: "design.settled", producerId: "x", payload: { revision: 7, settled: true } }) + "\n")
	return root
}

function stubLaunch() {
	const calls: any[] = []
	const kills: number[] = []
	let exit: (code: number) => void = () => {}
	const launch: HubLaunch = (args) => {
		calls.push(args)
		mkdirSync(args.outDir, { recursive: true })
		return { done: new Promise((r) => (exit = (code) => r({ code, stderr: "", stdout: "" } as never))), kill: () => (kills.push(1), exit(1)) }
	}
	return { launch, calls, kills, exit: (code: number) => exit(code) }
}

// node:http, so any Host/Origin header can be sent.
function call(base: string, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
	const { hostname, port } = new URL(base)
	return new Promise((ok, fail) => {
		const req = request({ hostname, port, path, method: opts.method ?? "GET", headers: { host: "bringup-demo.onrender.com", ...opts.headers } }, (res) => {
			let body = ""
			res.on("data", (c) => (body += c))
			res.on("end", () => ok({ status: res.statusCode!, body }))
		})
		req.on("error", fail)
		req.end(opts.body)
	})
}
const post = (base: string, path: string, body: object, headers: Record<string, string> = {}) => call(base, path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })

test("public: any host may read; the page carries the banner; every POST but Try it is a read-only 403", async () => {
	const s = stubLaunch()
	const hub = await serveHub({ outRoot: publicRoot(), port: 0, launch: s.launch, public: { gate: new PublicGate(), briefPath: join(import.meta.dirname, "../briefs/beacon.md") } })
	try {
		const page = await call(hub.url, "/")
		assert.equal(page.status, 200)
		assert.ok(page.body.includes(PUBLIC_BANNER))
		assert.ok(page.body.includes("window.BRINGUP_PUBLIC = true"), "the page knows it is the public demo (its empty views say why)")
		// The replays ship no fab files and ordering is off: the two buttons are hidden, so nothing 404s.
		assert.match(page.body, /<style>#fab, #order-btn \{ display: none !important \}<\/style>/)
		assert.match(PUBLIC_BANNER, /Public demo: recorded runs used the real tools \(KiCad, build123d, PlatformIO\); live runs here are stubbed\./)
		assert.equal((await call(hub.url, "/api/runs")).status, 200)
		for (const path of ["/api/runs/add-sensor/requests", "/api/runs/add-sensor/decisions", "/api/runs/add-sensor/ask", "/api/runs/add-sensor/stop", "/api/runs/add-sensor/drift/d1/revert"]) {
			const r = await post(hub.url, path, { text: "x", proposalId: "p-1", approve: true, question: "why" })
			assert.equal(r.status, 403, path)
			assert.match(r.body, /read-only demo/, path)
		}
		assert.equal((await call(hub.url, "/api/runs/add-sensor/ready-to-order")).status, 403)
		const hubInfo = JSON.parse((await call(hub.url, "/api/hub")).body)
		assert.equal(hubInfo.public, true)
		assert.equal(s.calls.length, 0)
	} finally {
		await hub.close()
	}
})

test("public Try it: a scripted, stubbed beacon run with one scripted change; one at a time; killed after the timeout", async () => {
	const s = stubLaunch()
	const hub = await serveHub({ outRoot: publicRoot(), port: 0, launch: s.launch, public: { gate: new PublicGate({ timeoutMs: 300, cleanupMs: 50 }), briefPath: join(import.meta.dirname, "../briefs/beacon.md") } })
	try {
		// The body is ignored: the brief, the models and the flags are fixed.
		const r = await post(hub.url, "/api/runs", { brief: "anything", mock: false, hardware: true, review: true, engineerApproval: true, bench: "real" }, { "x-forwarded-for": "9.9.9.9, 10.0.0.1" })
		assert.equal(r.status, 201, r.body)
		const runId = JSON.parse(r.body).runId
		assert.equal(s.calls.length, 1)
		assert.equal(s.calls[0].mock, true)
		assert.deepEqual(s.calls[0].extraArgs, ["--stay", "--no-hardware", "--no-review"])
		assert.match(readFileSync(s.calls[0].briefPath, "utf8"), /pocket BLE beacon/)
		assert.equal((await post(hub.url, "/api/runs", {})).status, 409, "one live run at a time")
		// Cross-site POSTs are refused even here.
		assert.equal((await post(hub.url, "/api/runs", {}, { origin: "https://evil.example" })).status, 403)
		assert.equal((await post(hub.url, `/api/runs/${runId}/requests`, { text: "add a temperature/humidity sensor" })).status, 201)
		assert.equal((await post(hub.url, `/api/runs/${runId}/requests`, { text: "make it 40 mm wide" })).status, 409, "one change per run")
		assert.equal(JSON.parse(readFileSync(join(s.calls[0].outDir, "requests.jsonl"), "utf8")).text, "add a temperature/humidity sensor")
		await new Promise((done) => setTimeout(done, 450))
		assert.equal(s.kills.length, 1, "the 3-minute limit (300 ms here) killed it")
		await new Promise((done) => setTimeout(done, 150))
		assert.ok(!existsSync(s.calls[0].outDir), "its out dir is cleaned up after")
		assert.equal((await post(hub.url, "/api/runs", {})).status, 201, "the next visitor can start one")
	} finally {
		await hub.close()
	}
})
