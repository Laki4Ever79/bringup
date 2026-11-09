// The dashboard's system page (src/dashboard/system.html): its API over a system folder, the boards opened as runs,
// and starting a system from the page.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { serveHub, type HubLaunch } from "../src/dashboard/server.ts"
import { tempDir } from "./helpers.ts"

function fakeSystem(root: string, id: string) {
	const dir = join(root, id)
	const spec = { name: "logger and beacon over UART", boards: [{ name: "logger", brief: "briefs/logger.md" }, { name: "beacon", brief: "briefs/beacon.md" }], links: [{ id: "L1", kind: "uart", a: { board: "logger" }, b: { board: "beacon" }, cable: { lengthMm: 300 } }] }
	mkdirSync(join(dir, "boards", "logger"), { recursive: true })
	writeFileSync(join(dir, "system.json"), JSON.stringify(spec))
	writeFileSync(join(dir, "system-state.json"), JSON.stringify({ status: "settled: every board settled with its links", settled: true, findings: [], linkTests: [{ link: "L1", ran: true, passed: true, detail: "reading arrived" }], asked: [{ board: "logger", text: "expose L1" }] }))
	writeFileSync(join(dir, "cable.md"), "# Cables\n\n## L1\n\n| Pin | Wire |\n|---|---|\n| 1 | black |\n")
	const b = join(dir, "boards", "logger")
	writeFileSync(join(b, "brief.md"), "# Climate logger\n")
	writeFileSync(join(b, "trace.jsonl"), [{ at: "2026-11-09T10:00:00Z", type: "run.started", payload: {} }, { at: "2026-11-09T10:01:00Z", type: "contract.changed", payload: { revision: 25 } }, { at: "2026-11-09T10:02:00Z", type: "design.settled", payload: { settled: true } }].map((e) => JSON.stringify(e)).join("\n") + "\n")
	writeFileSync(join(b, "contract.json"), JSON.stringify({ values: { outline: { widthMm: 50, heightMm: 30 }, connectors: [{ ref: "JL1", kind: "header", edge: "left", offsetMm: 12 }], pins: [{ signal: "L1_TX", gpio: 6, partRef: "JL1", partPin: "IO1" }, { signal: "I2C_SDA", gpio: 8, partRef: "U2", partPin: "SDA" }] } }))
	return dir
}

test("the hub lists a system apart from runs, details its boards and serves each board as a run", async () => {
	const root = tempDir()
	fakeSystem(root, "system-a")
	const hub = await serveHub({ outRoot: root, port: 0 })
	try {
		const get = (p: string) => fetch(`${hub.url}${p}`)
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const getJson = async (p: string): Promise<any> => (await get(p)).json()
		assert.deepEqual((await getJson("/api/runs")).map((r: { runId: string }) => r.runId), [], "a system folder is not a run")
		const list = await getJson("/api/systems")
		assert.deepEqual(list.map((s: { id: string; status: string; boards: number }) => [s.id, s.boards, s.status.split(":")[0]]), [["system-a", 2, "settled"]])
		const d = await getJson("/api/systems/system-a")
		assert.equal(d.settled, true)
		const logger = d.boards.find((b: { name: string }) => b.name === "logger")
		assert.equal(logger.runId, "system-a.logger")
		assert.equal(logger.status, "settled")
		assert.equal(logger.revision, 25)
		assert.deepEqual(logger.outline, { widthMm: 50, heightMm: 30 })
		assert.deepEqual(logger.pins.map((p: { signal: string }) => p.signal), ["L1_TX"], "only the link connector's pins")
		assert.equal(d.boards.find((b: { name: string }) => b.name === "beacon").status, "not started")
		assert.equal(d.linkTests[0].passed, true)
		assert.match(d.cable, /\| 1 \| black \|/)
		// The board opens on the run page: its events and files by the <system>.<board> id.
		assert.equal((await get("/runs/system-a.logger/files/brief.md")).status, 200)
		assert.equal((await get("/systems/system-a/files/cable.md")).status, 200)
		assert.equal((await get("/systems/system-a/files/brief.md")).status, 404, "only the system's own outputs")
		assert.equal((await get("/api/systems/system-a.logger")).status, 404)
		assert.equal((await get("/runs/system-a.nope/files/brief.md")).status, 404)
		assert.equal((await get("/system")).status, 200)
	} finally {
		await hub.close()
	}
})

test("the page starts a system with `main.ts system <spec>`, refuses a spec outside briefs/systems, and can stop it", async () => {
	const root = tempDir()
	const calls: Parameters<HubLaunch>[0][] = []
	let killed = false
	const launch: HubLaunch = (args) => {
		calls.push(args)
		return { done: new Promise(() => {}), kill: () => (killed = true) }
	}
	const hub = await serveHub({ outRoot: root, port: 0, launch })
	try {
		const post = (p: string, body: object) => fetch(`${hub.url}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
		assert.equal((await post("/api/systems", { spec: "../logger.md", mock: true, hardware: false, review: false })).status, 400)
		const r = await post("/api/systems", { spec: "logger-beacon-uart.json", mock: true, hardware: false, review: false })
		assert.equal(r.status, 201)
		const { systemId } = (await r.json()) as { systemId: string }
		assert.match(systemId, /^system-/)
		assert.equal(calls[0].briefPath, "system")
		assert.match(calls[0].extraArgs![0], /briefs\/systems\/logger-beacon-uart\.json$/)
		assert.deepEqual(calls[0].extraArgs!.slice(1), ["--mock", "--no-hardware", "--no-review"])
		assert.equal(calls[0].outDir, join(root, systemId))
		// The process writes system.json once it starts; until then the folder is not yet a system.
		writeFileSync(join(root, systemId, "system.json"), JSON.stringify({ name: "s", boards: [], links: [] }))
		assert.equal(((await (await fetch(`${hub.url}/api/systems/${systemId}`)).json()) as { status: string }).status, "running")
		assert.equal((await post(`/api/systems/${systemId}/stop`, {})).status, 200)
		assert.equal(killed, true)
	} finally {
		await hub.close()
	}
})

test("the system and each board report what their model calls spent", async () => {
	const root = tempDir()
	const dir = fakeSystem(root, "system-a")
	writeFileSync(join(dir, "boards", "logger", "usage.jsonl"), JSON.stringify({ at: "2026-11-09T10:00:00Z", model: "gpt-5.4-mini", source: "agents", inputTokens: 1, cachedTokens: 0, outputTokens: 1, usd: 0.25 }) + "\n")
	const hub = await serveHub({ outRoot: root, port: 0 })
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const getJson = async (p: string): Promise<any> => (await fetch(`${hub.url}${p}`)).json()
		assert.deepEqual((await getJson("/api/systems/system-a")).spend, { usd: 0.25, calls: 1, unknownCalls: 0 })
		assert.deepEqual(await getJson("/api/runs/system-a.logger/spend"), { usd: 0.25, calls: 1, unknownCalls: 0 })
	} finally {
		await hub.close()
	}
})
