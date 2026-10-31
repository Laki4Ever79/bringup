import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { askPrompt, revisionsToLoad } from "../src/dashboard/ask.ts"
import { serveHub } from "../src/dashboard/server.ts"

const line = (seq: number, type: string, payload: object) => JSON.stringify({ seq, at: `2026-10-31T12:00:${String(seq).padStart(2, "0")}.000Z`, type, producerId: "x", payload }) + "\n"
const outline = (w: number) => ({ widthMm: w, heightMm: 30, thicknessMm: 1.6 })
const trace = (mock: boolean) =>
	line(0, "run.started", { review: true, engineerApproval: false, noHardware: true, bench: false, stay: true, mock }) +
	line(1, "contract.changed", { field: "outline", version: 1, revision: 4, by: "architect", reason: "50 × 30 mm from the brief", before: null, after: outline(50), cause: { kind: "brief" } }) +
	line(2, "change.requested", { id: "req-1", text: "make it 40 mm wide" }) +
	line(3, "contract.changed", { field: "outline", version: 2, revision: 8, by: "architect", reason: "engineer asked for 40 mm wide", before: outline(50), after: outline(40), cause: { kind: "request", id: "req-1", text: "make it 40 mm wide" } })

function run(mock: boolean): { root: string; id: string } {
	const root = mkdtempSync(join(tmpdir(), "bringup-ask-"))
	const id = "20261031-120000-aaaaaa"
	mkdirSync(join(root, id, "contracts"), { recursive: true })
	writeFileSync(join(root, id, "trace.jsonl"), trace(mock))
	writeFileSync(join(root, id, "brief.md"), "# Brief: pocket climate logger\n")
	writeFileSync(join(root, id, "contracts/rev-7.json"), JSON.stringify({ revision: 7, values: { outline: outline(50) }, versions: { outline: 1 } }))
	writeFileSync(join(root, id, "contracts/rev-8.json"), JSON.stringify({ revision: 8, values: { outline: outline(40) }, versions: { outline: 2 } }))
	return { root, id }
}

test("the prompt holds the change log (who, the diff, the reason, the cause), the requests, both snapshots and the question", () => {
	const events = trace(false).trim().split("\n").map((l) => JSON.parse(l))
	const p = askPrompt({ question: "why is the board narrower?", events, from: { revision: 7, values: { outline: outline(50) } }, to: { revision: 8, values: { outline: outline(40) } }, brief: "pocket climate logger" })
	assert.match(p.system, /cite.*rev/i)
	assert.match(p.system, /not recorded/i)
	assert.match(p.user, /rev 8 · outline v1 → v2 · by architect/)
	assert.match(p.user, /outline 50×30 → 40×30 mm/)
	assert.match(p.user, /reason: engineer asked for 40 mm wide/)
	assert.match(p.user, /cause: request #1 “make it 40 mm wide”/)
	assert.match(p.user, /req-1: make it 40 mm wide/)
	assert.match(p.user, /Contract at rev 7:[\s\S]*"widthMm":50/)
	assert.match(p.user, /Contract at rev 8:[\s\S]*"widthMm":40/)
	assert.match(p.user, /Question: why is the board narrower\?/)
})

test("POST /api/runs/:id/ask: a scripted run answers from no model; a real one asks the model once, with the run's facts", async () => {
	const calls: { system: string; user: string }[] = []
	const ask = async (p: { system: string; user: string }) => (calls.push(p), "The architect narrowed it to 40 mm because you asked (rev 8).")
	for (const mock of [true, false]) {
		const { root, id } = run(mock)
		const hub = await serveHub({ outRoot: root, port: 0, ask })
		try {
			const res = await fetch(`${hub.url}/api/runs/${id}/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "why is it narrower?", from: 7, to: 8 }) })
			assert.equal(res.status, 200)
			const body = (await res.json()) as { answer: string; scripted: boolean }
			if (mock) {
				assert.equal(body.scripted, true)
				assert.match(body.answer, /scripted mode: see the change log above/i)
				assert.equal(calls.length, 0, "no model call for a scripted run")
			} else {
				assert.equal(body.scripted, false)
				assert.equal(body.answer, "The architect narrowed it to 40 mm because you asked (rev 8).")
				assert.equal(calls.length, 1)
				assert.match(calls[0].user, /Question: why is it narrower\?/)
				assert.match(calls[0].user, /reason: engineer asked for 40 mm wide/)
			}
		} finally {
			await hub.close()
		}
	}
})

test("ask: an empty question or an unknown run is refused; with no model key the hub says how to set one", async () => {
	const { root, id } = run(false)
	const hub = await serveHub({ outRoot: root, port: 0, ask: async () => { throw Object.assign(new Error("no API key"), { code: "NO_KEY" }) } })
	try {
		const post = (path: string, body: object) => fetch(`${hub.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
		assert.equal((await post(`/api/runs/${id}/ask`, { question: " " })).status, 400)
		assert.equal((await post(`/api/runs/nope/ask`, { question: "why?" })).status, 404)
		const res = await post(`/api/runs/${id}/ask`, { question: "why?" })
		assert.equal(res.status, 503)
		assert.match(((await res.json()) as { error: string }).error, /OPENAI_API_KEY|ANTHROPIC_API_KEY/)
	} finally {
		await hub.close()
	}
})

test("callModel: the runs' provider and strong model, the key only in the header, and no key → a clear error", async () => {
	const { callModel } = await import("../src/dashboard/ask.ts")
	const seen: { url: string; init: any }[] = []
	const fake = (body: object) => (async (url: string, init: any) => (seen.push({ url, init }), new Response(JSON.stringify(body), { status: 200 }))) as unknown as typeof fetch
	const p = { system: "S", user: "U" }
	assert.equal(await callModel(p, { OPENAI_API_KEY: "k-test" }, fake({ choices: [{ message: { content: " rev 8: narrower. " } }] })), "rev 8: narrower.")
	assert.equal(seen[0].url, "https://api.openai.com/v1/chat/completions")
	assert.equal(seen[0].init.headers.authorization, "Bearer k-test")
	assert.equal(JSON.parse(seen[0].init.body).model, "gpt-5.4")
	assert.equal(await callModel(p, { ANTHROPIC_API_KEY: "a-test", ANTHROPIC_BASE_URL: "https://gw.example/" }, fake({ content: [{ text: "rev 8." }] })), "rev 8.")
	assert.equal(seen[1].url, "https://gw.example/v1/messages")
	assert.equal(seen[1].init.headers["x-api-key"], "a-test")
	assert.equal(JSON.parse(seen[1].init.body).model, "claude-sonnet-4-6")
	await assert.rejects(callModel(p, {}, fake({})), /OPENAI_API_KEY/)
})

test("an older trace (no values) gets each write's change from the revision snapshots, so the model sees what changed", () => {
	const events = [{ type: "contract.changed", payload: { field: "outline", version: 2, revision: 20, by: "architect" } }]
	const snapshots = new Map([[19, { revision: 19, values: { outline: outline(50) } }], [20, { revision: 20, values: { outline: outline(40) } }]])
	const p = askPrompt({ question: "why?", events, from: null, to: null, brief: "logger", snapshots })
	assert.match(p.user, /change: outline 50×30 → 40×30 mm/)
	assert.match(p.user, /reason: not recorded \(older run\)/)
	assert.deepEqual(revisionsToLoad(events), [19, 20])
})
