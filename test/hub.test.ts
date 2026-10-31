import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { serveHub, type HubLaunch } from "../src/dashboard/server.ts"

const line = (seq: number, type: string, payload: object, at = `2026-10-31T12:00:0${seq}.000Z`) => JSON.stringify({ seq, at, type, producerId: "x", payload }) + "\n"

function outRoot() {
	const root = mkdtempSync(join(tmpdir(), "bringup-hub-"))
	const run = (id: string, trace: string, brief = "BLE logger\n") => {
		mkdirSync(join(root, id))
		writeFileSync(join(root, id, "trace.jsonl"), trace)
		writeFileSync(join(root, id, "brief.md"), brief)
	}
	run("20261031-120000-aaaaaa", line(0, "contract.changed", { field: "outline", version: 1, revision: 1, by: "architect" }) + line(1, "design.settled", { revision: 4, settled: true }))
	run("20261031-130000-bbbbbb", line(0, "contract.changed", { field: "outline", version: 1, revision: 2, by: "architect" }, "2026-10-31T13:00:00.000Z"), "# Tiny blinky\nwith a button")
	mkdirSync(join(root, "not a run"))
	writeFileSync(join(root, "stray.txt"), "")
	return root
}

// A launch stub: records its args and finishes when release(code) is called.
function stubLaunch() {
	const calls: any[] = []
	let release: (code: number) => void = () => {}
	const launch: HubLaunch = (args) => {
		calls.push(args)
		return { done: new Promise((r) => (release = (code) => r({ code, stderr: code === 1 ? "boom" : "" }))), kill: () => {} }
	}
	return { launch, calls, release: (code: number) => release(code) }
}

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
	const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) })
	return { status: res.status, json: (await res.json().catch(() => null)) as any }
}

// node:http lets us send any Host/Origin header (fetch forbids setting Host).
function raw(base: string, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string }): Promise<number> {
	const { hostname, port } = new URL(base)
	return new Promise((ok, fail) => {
		const req = request({ hostname, port, path, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
			res.resume()
			ok(res.statusCode!)
		})
		req.on("error", fail)
		req.end(opts.body)
	})
}

test("GET /api/runs lists runs newest first with status, revision, start and title", async () => {
	const hub = await serveHub({ outRoot: outRoot(), port: 0 })
	try {
		const runs: any = await (await fetch(`${hub.url}/api/runs`)).json()
		assert.deepEqual(
			runs.map((r: any) => [r.runId, r.status, r.revision, r.title]),
			[
				["20261031-130000-bbbbbb", "stopped", 2, "Tiny blinky"],
				["20261031-120000-aaaaaa", "settled", 4, "BLE logger"],
			],
		)
		assert.equal(runs[1].startedAt, "2026-10-31T12:00:00.000Z")
	} finally {
		await hub.close()
	}
})

test("POST /api/runs writes the brief, launches with the flags and tracks the run", async () => {
	const root = outRoot()
	const stub = stubLaunch()
	const hub = await serveHub({ outRoot: root, port: 0, launch: stub.launch })
	try {
		const r = await post(hub.url, "/api/runs", { brief: "Pocket CO2 sensor", mock: true, hardware: false, review: false, engineerApproval: true })
		assert.equal(r.status, 201)
		const { runId } = r.json
		assert.match(runId, /^[\w-]+$/)
		assert.equal(readFileSync(join(root, runId, "brief.md"), "utf8"), "Pocket CO2 sensor\n")
		assert.deepEqual(stub.calls[0], { briefPath: join(root, runId, "brief.md"), mock: true, outDir: join(root, runId), extraArgs: ["--stay", "--no-hardware", "--no-review", "--engineer-approval"] })
		let runs: any = await (await fetch(`${hub.url}/api/runs`)).json()
		assert.equal(runs.find((x: any) => x.runId === runId).status, "running")
		stub.release(1)
		await new Promise((r) => setTimeout(r, 50))
		runs = await (await fetch(`${hub.url}/api/runs`)).json()
		assert.equal(runs.find((x: any) => x.runId === runId).status, "failed")
	} finally {
		await hub.close()
	}
})

test("hardware and review on add no flags", async () => {
	const stub = stubLaunch()
	const hub = await serveHub({ outRoot: outRoot(), port: 0, launch: stub.launch })
	try {
		await post(hub.url, "/api/runs", { brief: "x", mock: false, hardware: true, review: true, engineerApproval: false })
		assert.deepEqual(stub.calls[0].extraArgs, ["--stay"], "runs started here stay up after settling, until Stop")
		assert.equal(stub.calls[0].mock, false)
	} finally {
		await hub.close()
	}
})

test("POST bodies are validated", async () => {
	const stub = stubLaunch()
	const hub = await serveHub({ outRoot: outRoot(), port: 0, launch: stub.launch })
	try {
		assert.equal((await post(hub.url, "/api/runs", { brief: "", mock: true, hardware: true, review: true, engineerApproval: false })).status, 400)
		assert.equal((await post(hub.url, "/api/runs", { brief: "x", mock: "yes" })).status, 400)
		assert.equal((await post(hub.url, "/api/runs", "{not json")).status, 400)
		assert.equal((await post(hub.url, "/api/runs", { brief: "x".repeat(70_000), mock: true, hardware: true, review: true, engineerApproval: false })).status, 413)
		const form = await fetch(`${hub.url}/api/runs`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "brief=x" })
		assert.equal(form.status, 415, "only JSON, so a cross-site form can't post")
		const bad = await post(hub.url, "/api/runs", { brief: "x" })
		assert.match(bad.json.error, /mock/)
		assert.equal(stub.calls.length, 0)
	} finally {
		await hub.close()
	}
})

test("cross-site and DNS-rebinding requests are refused", async () => {
	const stub = stubLaunch()
	const hub = await serveHub({ outRoot: outRoot(), port: 0, launch: stub.launch })
	try {
		const body = JSON.stringify({ brief: "x", mock: true, hardware: true, review: true, engineerApproval: false })
		const host = new URL(hub.url).host
		assert.equal(await raw(hub.url, "/api/runs", { method: "POST", headers: { host, origin: "https://evil.example", "content-type": "application/json" }, body }), 403)
		assert.equal(await raw(hub.url, "/api/runs", { method: "POST", headers: { host: "evil.example", "content-type": "application/json" }, body }), 403)
		assert.equal(await raw(hub.url, "/api/runs", { method: "GET", headers: { host: "rebind.evil.example" } }), 403)
		assert.equal(await raw(hub.url, "/api/runs", { method: "POST", headers: { host, origin: hub.url, "content-type": "application/json" }, body }), 201)
		assert.equal(stub.calls.length, 1)
	} finally {
		await hub.close()
	}
})

test("a hub without a launcher can't start runs", async () => {
	const hub = await serveHub({ outRoot: outRoot(), port: 0 })
	try {
		assert.equal((await post(hub.url, "/api/runs", { brief: "x", mock: true, hardware: true, review: true, engineerApproval: false })).status, 404)
	} finally {
		await hub.close()
	}
})

test("change requests and decisions are appended to the run's files", async () => {
	const root = outRoot()
	const hub = await serveHub({ outRoot: root, port: 0 })
	const id = "20261031-120000-aaaaaa"
	try {
		assert.equal((await post(hub.url, `/api/runs/${id}/requests`, { text: "make it 60 mm wide" })).status, 201)
		const req = JSON.parse(readFileSync(join(root, id, "requests.jsonl"), "utf8"))
		assert.equal(req.text, "make it 60 mm wide")
		assert.equal((await post(hub.url, `/api/runs/${id}/decisions`, { proposalId: "p-1", approve: false, reason: "keep GPIO10" })).status, 201)
		const d = JSON.parse(readFileSync(join(root, id, "decisions.jsonl"), "utf8"))
		assert.deepEqual({ ...d, at: typeof d.at }, { at: "string", proposalId: "p-1", approve: false, reason: "keep GPIO10" })
		assert.equal((await post(hub.url, `/api/runs/${id}/requests`, { text: "" })).status, 400)
		assert.equal((await post(hub.url, `/api/runs/${id}/decisions`, { proposalId: "p-1", approve: "no", reason: "" })).status, 400)
		assert.equal((await post(hub.url, `/api/runs/nope/requests`, { text: "x" })).status, 404)
		assert.equal(await raw(hub.url, `/api/runs/..%2f..%2fetc/requests`, { method: "POST", headers: { host: new URL(hub.url).host, "content-type": "application/json" }, body: '{"text":"x"}' }), 404)
	} finally {
		await hub.close()
	}
})

test("per-run events and files, scoped to that run", async () => {
	const root = outRoot()
	const id = "20261031-120000-aaaaaa"
	writeFileSync(join(root, id, "contract.json"), '{"revision":4}')
	writeFileSync(join(root, "secret.txt"), "no")
	symlinkSync(join(root, "secret.txt"), join(root, id, "link.txt"))
	const hub = await serveHub({ outRoot: root, port: 0 })
	try {
		assert.deepEqual(await (await fetch(`${hub.url}/runs/${id}/files/contract.json`)).json(), { revision: 4 })
		const host = new URL(hub.url).host
		for (const path of [`/runs/${id}/files/../../secret.txt`, `/runs/${id}/files/%2e%2e/secret.txt`, `/runs/${id}/files/link.txt`, `/runs/..%2f/files/secret.txt`, `/runs/nope/files/contract.json`]) {
			const s = await raw(hub.url, path, { headers: { host } })
			assert.ok(s === 403 || s === 404, `${path} → ${s}`)
		}
		const res = await fetch(`${hub.url}/runs/${id}/events`)
		assert.equal(res.headers.get("content-type"), "text/event-stream")
		const reader = res.body!.getReader()
		let text = ""
		while ((text.match(/^data: /gm) ?? []).length < 2) text += new TextDecoder().decode((await reader.read()).value)
		await reader.cancel()
		assert.match(text, /"design.settled"/)
	} finally {
		await hub.close()
	}
})

test("the page and its modules are served; missing optional modules are 404", async () => {
	const hub = await serveHub({ outRoot: outRoot(), port: 0 })
	try {
		assert.equal((await fetch(`${hub.url}/`)).status, 200)
		assert.equal((await fetch(`${hub.url}/model.js`)).status, 200)
		assert.equal((await fetch(`${hub.url}/rulers.js`)).status, 200)
		for (const m of ["pcb-view.js", "scene3d.js"]) {
			const s = (await fetch(`${hub.url}/${m}`)).status
			assert.ok(s === 200 || s === 404, `${m} → ${s}`)
		}
		assert.equal(existsSync(new URL("../src/dashboard/server.ts", import.meta.url)), true)
		assert.equal((await fetch(`${hub.url}/server.ts`)).status, 404)
	} finally {
		await hub.close()
	}
})

test("GET /api/briefs lists the example briefs with a title", async () => {
	const hub = await serveHub({ outRoot: outRoot(), port: 0 })
	try {
		const briefs: any = await (await fetch(`${hub.url}/api/briefs`)).json()
		assert.ok(briefs.length >= 2)
		const logger = briefs.find((b: any) => b.name === "logger.md")
		assert.ok(logger.title.length > 0 && !logger.title.startsWith("#"))
		assert.match(logger.text, /\S/)
		assert.ok(!briefs.some((b: any) => b.name === "README.md"), "the folder's README is not a brief")
	} finally {
		await hub.close()
	}
})

test("a run can be started with the live bench, and only a running run can be stopped", async () => {
	const stub = stubLaunch()
	let killed = 0
	const launch: HubLaunch = (args) => ({ ...stub.launch(args), kill: () => void killed++ })
	const root = outRoot()
	const hub = await serveHub({ outRoot: root, port: 0, launch })
	try {
		const bad = await post(hub.url, "/api/runs", { brief: "x", mock: true, hardware: true, review: true, engineerApproval: false, bench: "usb" })
		assert.equal(bad.status, 400)
		const { json } = await post(hub.url, "/api/runs", { brief: "x", mock: true, hardware: true, review: true, engineerApproval: false, bench: "fake" })
		assert.deepEqual(stub.calls.at(-1).extraArgs, ["--stay", "--bench", "fake"])
		const runs: any = await (await fetch(hub.url + "/api/runs")).json()
		assert.equal(runs.find((r: any) => r.runId === json.runId).bench, false, "no bench.connected in the trace yet")
		writeFileSync(join(root, json.runId, "trace.jsonl"), line(0, "bench.connected", { source: "fake", ports: {}, meter: true }) + line(1, "design.settled", { revision: 3, settled: true }))
		const live = ((await (await fetch(hub.url + "/api/runs")).json()) as any[]).find((r: any) => r.runId === json.runId)
		assert.deepEqual([live.status, live.bench], ["bench live", true], "a settled run with its bench still up is bench live")
		assert.equal((await post(hub.url, `/api/runs/${json.runId}/stop`, {})).status, 200)
		assert.equal(killed, 1)
		assert.equal((await post(hub.url, "/api/runs/20261031-120000-aaaaaa/stop", {})).status, 409, "not running here")
		assert.equal((await post(hub.url, "/api/runs/nope/stop", {})).status, 404)
	} finally {
		await hub.close()
	}
})

test("a settled run that stays up is 'waiting for a change' until it is stopped", async () => {
	const stub = stubLaunch()
	const root = outRoot()
	const hub = await serveHub({ outRoot: root, port: 0, launch: stub.launch })
	try {
		const { json } = await post(hub.url, "/api/runs", { brief: "x", mock: true, hardware: true, review: true, engineerApproval: false })
		const status = async () => ((await (await fetch(hub.url + "/api/runs")).json()) as any[]).find((r: any) => r.runId === json.runId).status
		writeFileSync(join(root, json.runId, "trace.jsonl"), line(0, "run.started", { review: true, engineerApproval: false, noHardware: false, bench: false, stay: true }))
		assert.equal(await status(), "running")
		writeFileSync(join(root, json.runId, "trace.jsonl"), line(0, "run.started", { review: true, engineerApproval: false, noHardware: false, bench: false, stay: true }) + line(1, "design.settled", { revision: 3, settled: true }))
		assert.equal(await status(), "waiting for a change")
		writeFileSync(join(root, json.runId, "trace.jsonl"), line(0, "run.started", { review: true, engineerApproval: false, noHardware: false, bench: false, stay: true }) + line(1, "design.settled", { revision: 3, settled: true }) + line(2, "change.requested", { id: "req-1", text: "make it 40 mm wide" }) + line(3, "contract.changed", { field: "outline", version: 2, revision: 4, by: "architect" }))
		assert.equal(await status(), "running", "a change in flight")
		stub.release(0)
		await new Promise((r) => setTimeout(r, 50))
		assert.equal(await status(), "settled")
	} finally {
		await hub.close()
	}
})

test("a run started elsewhere (npm run demo) can be adopted: its status is live and Stop reaches it", async () => {
	const root = outRoot()
	const hub = await serveHub({ outRoot: root, port: 0 })
	try {
		const id = "demo-20261031-120000"
		mkdirSync(join(root, id))
		writeFileSync(join(root, id, "trace.jsonl"), line(0, "run.started", { review: true, engineerApproval: false, noHardware: false, bench: false, stay: true }) + line(1, "design.settled", { revision: 3, settled: true }))
		let killed = 0
		let exit: (code: number) => void = () => {}
		hub.adopt(id, { done: new Promise((r) => (exit = (code) => r({ code }))), kill: () => void killed++ })
		const status = async () => ((await (await fetch(hub.url + "/api/runs")).json()) as any[]).find((r: any) => r.runId === id).status
		assert.equal(await status(), "waiting for a change")
		assert.equal((await post(hub.url, `/api/runs/${id}/stop`, {})).status, 200)
		assert.equal(killed, 1)
		exit(0)
		await new Promise((r) => setTimeout(r, 50))
		assert.equal(await status(), "settled")
	} finally {
		await hub.close()
	}
})

test("the run list: the title without its \"Brief:\" prefix, how many changes were asked, and the last ripple's time", async () => {
	const root = outRoot()
	const hub = await serveHub({ outRoot: root, port: 0 })
	try {
		const id = "20261031-140000-cccccc"
		mkdirSync(join(root, id))
		writeFileSync(join(root, id, "brief.md"), "# Brief: pocket climate logger\n")
		writeFileSync(join(root, id, "trace.jsonl"), line(0, "run.started", { stay: true }) + line(1, "design.settled", { revision: 7, settled: true }) + line(2, "change.requested", { id: "req-1", text: "make it 60 mm wide" }) + line(3, "change.requested", { id: "req-2", text: "make it 40 mm wide" }))
		writeFileSync(join(root, id, "ripples.json"), JSON.stringify({ requests: [{ id: "req-1", durationMs: 56_000, consistentAtMs: 80_000 }, { id: "req-2", durationMs: null, consistentAtMs: null }] }))
		const runs = (await (await fetch(`${hub.url}/api/runs`)).json()) as any[]
		const r = runs.find((x) => x.runId === id)
		assert.equal(r.title, "pocket climate logger")
		assert.deepEqual(r.changes, { count: 2, lastDurationMs: 56_000 })
		const plain = runs.find((x) => x.runId === "20261031-120000-aaaaaa")
		assert.deepEqual(plain.changes, { count: 0, lastDurationMs: null })
	} finally {
		await hub.close()
	}
})

test("the run list's revision is the contract's, not a bench board's recorded rev", async () => {
	const root = outRoot()
	mkdirSync(join(root, "20261031-140000-cccccc"))
	writeFileSync(join(root, "20261031-140000-cccccc", "trace.jsonl"), line(0, "contract.changed", { field: "outline", version: 1, revision: 7, by: "architect" }) + line(1, "bench.telemetry", { revision: 15, source: "replay", samples: [] }) + line(2, "bench.verdict", { revision: 15, pass: true, source: "replay", checks: [] }))
	const hub = await serveHub({ outRoot: root, port: 0 })
	try {
		const runs: any = await (await fetch(hub.url + "/api/runs")).json()
		assert.equal(runs.find((r: any) => r.runId === "20261031-140000-cccccc").revision, 7)
	} finally {
		await hub.close()
	}
})
