import { test } from "node:test"
import assert from "node:assert/strict"
import { ntfyNotifier, notifierFromEnv } from "../src/dashboard/notify.ts"

const now = Date.parse("2026-10-31T15:00:00.000Z")
const line = (type: string, payload: object, at = "2026-10-31T15:00:01.000Z") => JSON.stringify({ seq: 1, at, type, producerId: "x", payload })
const held = (over: object = {}) => line("change.proposed", { proposalId: "p-7", field: "pins", by: "firmware", reason: "firmware drives a status LED on GPIO10", needsEngineer: true, ...over })

function fakeFetch() {
	const calls: { url: string; init: RequestInit }[] = []
	const fetch = (async (url: string, init: RequestInit) => {
		calls.push({ url, init })
		return new Response("{}", { status: 200 })
	}) as unknown as typeof globalThis.fetch
	return { fetch, calls, body: (i: number) => JSON.parse(calls[i].init.body as string) }
}

const make = (f: ReturnType<typeof fakeFetch>) => ntfyNotifier({ topic: "bringup-x7Qp2", hubUrl: "http://192.168.1.50:4317", token: "tok123", fetch: f.fetch, now: () => now })

test("a change held for the engineer is pushed to the ntfy topic with Approve and Reject buttons on the hub's decision route", async () => {
	const f = fakeFetch()
	await make(f)("20261031-150000-abcdef", held())
	assert.equal(f.calls.length, 1)
	assert.equal(f.calls[0].url, "https://ntfy.sh/")
	assert.equal(f.calls[0].init.method, "POST")
	const b = f.body(0)
	assert.equal(b.topic, "bringup-x7Qp2")
	assert.match(b.title, /pins/)
	assert.deepEqual(b.actions.map((a: any) => a.label), ["Approve", "Reject"])
	for (const [i, approve] of [[0, true], [1, false]] as const) {
		const a = b.actions[i]
		assert.equal(a.action, "http")
		assert.equal(a.method, "POST")
		assert.equal(a.url, "http://192.168.1.50:4317/api/runs/20261031-150000-abcdef/decisions")
		assert.equal(a.headers["X-Bringup-Token"], "tok123")
		assert.equal(a.headers["Content-Type"], "application/json")
		assert.deepEqual(JSON.parse(a.body), { proposalId: "p-7", approve, reason: approve ? "approved from the phone" : "rejected from the phone" })
	}
})

test("the push carries only the field and a short summary: no contract values, the reason cut short", async () => {
	const f = fakeFetch()
	await make(f)("r1", held({ reason: "x".repeat(500), value: { secret: "contract dump" } }))
	const text = JSON.stringify({ title: f.body(0).title, message: f.body(0).message })
	assert.ok(!text.includes("contract dump"))
	assert.ok(f.body(0).message.length <= 160, f.body(0).message)
})

test("only held changes that need the engineer, each once, and not old ones replayed from a trace", async () => {
	const f = fakeFetch()
	const notify = make(f)
	await notify("r1", held({ needsEngineer: false }))
	await notify("r1", line("contract.changed", { field: "pins" }))
	await notify("r1", "not json")
	await notify("r1", held({ proposalId: "once" }))
	await notify("r1", held({ proposalId: "once" }))
	await notify("r1", line("change.proposed", { proposalId: "stale", field: "outline", by: "architect", reason: "", needsEngineer: true }, "2026-10-31T14:00:00.000Z"))
	assert.equal(f.calls.length, 1)
	assert.ok(f.body(0).actions[0].body.includes('"once"'))
})

test("a failed push is swallowed: ntfy being down never stops the hub", async () => {
	const notify = ntfyNotifier({ topic: "t", hubUrl: "http://h:1", token: "k", fetch: (async () => { throw new Error("offline") }) as unknown as typeof fetch, now: () => now })
	await notify("r1", held())
})

test("off unless BRINGUP_NTFY_TOPIC is set; BRINGUP_NTFY_SERVER picks another ntfy server", async () => {
	assert.equal(notifierFromEnv({}, { hubUrl: "http://h:1", token: "k" }), null)
	const f = fakeFetch()
	const notify = notifierFromEnv({ BRINGUP_NTFY_TOPIC: "t", BRINGUP_NTFY_SERVER: "https://ntfy.example.org" }, { hubUrl: "http://h:1", token: "k", fetch: f.fetch, now: () => now })!
	await notify("r1", held())
	assert.equal(f.calls[0].url, "https://ntfy.example.org/")
})
