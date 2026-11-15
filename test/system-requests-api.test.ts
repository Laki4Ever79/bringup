// POST /api/systems/:id/requests: Apply's endpoint. A request is validated as the merged result, refused when the design
// is not staying up, and otherwise appended as one line to system-requests.jsonl for the --stay run to take.
import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { serveHub, type HubLaunch } from "../src/dashboard/server.ts"
import { SYSTEM_REQUESTS } from "../src/system/run.ts"
import { SYSTEM_TRACE } from "../src/system/trace.ts"
import { defaultAssembly } from "../src/system/assembly.ts"
import type { SystemSpec } from "../src/system/spec.ts"
import { tempDir } from "./helpers.ts"

const spec = (): SystemSpec => {
	const s: SystemSpec = { name: "bot", boards: [{ name: "main", brief: "m.md" }, { name: "front", brief: "f.md" }], links: [{ id: "L1", kind: "uart", a: { board: "main" }, b: { board: "front" }, cable: { lengthMm: 100 } }] }
	const o = { widthMm: 40, heightMm: 30 }
	return { ...s, assembly: defaultAssembly(s, "chassis", { main: o, front: o }) }
}

// A hub whose launch is a stub: POST /api/systems puts the id in the live map, and the test writes what the run would.
async function withSystem(fn: (h: { url: string; dir: string; id: string; post: (p: string, b: object) => Promise<Response>; stay: () => void }) => Promise<void>) {
	const root = tempDir()
	const launch: HubLaunch = () => ({ done: new Promise(() => {}), kill: () => {} })
	const hub = await serveHub({ outRoot: root, port: 0, launch })
	try {
		const post = (p: string, body: object) => fetch(`${hub.url}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
		const { systemId: id } = (await (await post("/api/systems", { spec: "logger-beacon-uart.json", mock: true, hardware: false, review: false })).json()) as { systemId: string }
		const dir = join(root, id)
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, "system.json"), JSON.stringify(spec()))
		const line = (l: object) => appendFileSync(join(dir, SYSTEM_TRACE), JSON.stringify({ at: new Date().toISOString(), ...l }) + "\n")
		const stay = () => {
			line({ round: 0, board: "system", step: "settled", status: "ok" })
			line({ round: 0, board: "system", step: "request", status: "ok", detail: "staying up for system-level changes" })
		}
		await fn({ url: hub.url, dir, id, post, stay })
	} finally {
		await hub.close()
	}
}

test("requests to a system that is not running are refused with the reason", async () => {
	await withSystem(async ({ id, dir, post }) => {
		// A live process that was not started with --stay (no staying-up line in its trace).
		const r = await post(`/api/systems/${id}/requests`, { assembly: { boards: spec().assembly!.boards } })
		assert.equal(r.status, 409)
		assert.match(((await r.json()) as { error: string }).error, /This design isn't running; start it again to apply changes/)
		assert.equal(existsSync(join(dir, SYSTEM_REQUESTS)), false)
	})
	// A recorded design no process here owns.
	const root = tempDir()
	mkdirSync(join(root, "old"), { recursive: true })
	writeFileSync(join(root, "old", "system.json"), JSON.stringify(spec()))
	writeFileSync(join(root, "old", SYSTEM_TRACE), JSON.stringify({ at: "2026-11-01T00:00:00Z", round: 0, board: "system", step: "request", status: "ok", detail: "staying up for system-level changes" }) + "\n")
	const hub = await serveHub({ outRoot: root, port: 0 })
	try {
		const r = await fetch(`${hub.url}/api/systems/old/requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ links: [] }) })
		assert.equal(r.status, 409)
		assert.equal((await fetch(`${hub.url}/api/systems/nope/requests`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404)
	} finally {
		await hub.close()
	}
})

test("a valid request is appended as exactly one line and answers the next round", async () => {
	await withSystem(async ({ id, dir, post, stay }) => {
		stay()
		const boards = spec().assembly!.boards.map((b) => (b.name === "front" ? { ...b, xMm: b.xMm + 5 } : b))
		const r = await post(`/api/systems/${id}/requests`, { text: "move front", assembly: { boards } })
		assert.equal(r.status, 202)
		assert.deepEqual(await r.json(), { round: 1 })
		const lines = readFileSync(join(dir, SYSTEM_REQUESTS), "utf8").trim().split("\n")
		assert.equal(lines.length, 1)
		const got = JSON.parse(lines[0])
		assert.equal(got.text, "move front")
		assert.deepEqual(got.assembly.boards, boards)
		assert.equal(typeof got.at, "string")
		await post(`/api/systems/${id}/requests`, { assembly: { boards } })
		assert.equal(readFileSync(join(dir, SYSTEM_REQUESTS), "utf8").trim().split("\n").length, 2)
	})
})

test("an invalid merged result is a 400 with the list, and nothing is appended", async () => {
	await withSystem(async ({ id, dir, post, stay }) => {
		stay()
		const boards = spec().assembly!.boards.map((b) => (b.name === "front" ? { ...b, xMm: 0, yMm: 0 } : b))
		const r = await post(`/api/systems/${id}/requests`, { assembly: { boards } })
		assert.equal(r.status, 400)
		const body = (await r.json()) as { errors: string[] }
		assert.ok(body.errors.some((e) => /overlap/.test(e)), body.errors.join("; "))
		const bad = await post(`/api/systems/${id}/requests`, { links: [{ id: "L1", kind: "uart", a: { board: "main" }, b: { board: "ghost" }, cable: { lengthMm: 100 } }] })
		assert.equal(bad.status, 400)
		assert.equal((await post(`/api/systems/${id}/requests`, { text: "nothing to change" })).status, 400)
		assert.equal(existsSync(join(dir, SYSTEM_REQUESTS)), false)
	})
})
