import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { createHuman } from "@mozaik-ai/core"
import { startCloudSession } from "../src/runner/cloud.ts"
import { makeEvent } from "../src/events.ts"
import { BringupState, emit, join, startRuntime, state } from "../src/runtime.ts"
import { tempDir, waitFor } from "./helpers.ts"

afterEach(() => new Promise((r) => setTimeout(r, 50)))

const none = () => null

test("no key anywhere: Cloud stays off and nothing is touched", () => {
	const env: NodeJS.ProcessEnv = { MOZAIK_API_KEY: "" }
	let created = 0
	const s = startCloudSession(() => [], { env, readCached: none, create: () => (created++, null as never), log: () => {} })
	assert.equal(s, null)
	assert.equal(created, 0)
	assert.deepEqual(env, { MOZAIK_API_KEY: "" })
})

test("a key starts one exporter session and turns the per-loop telemetry off", () => {
	const env: NodeJS.ProcessEnv = { MOZAIK_API_KEY: "mk_live_123" }
	const configs: any[] = []
	const log: string[] = []
	const fake = { participant: createHuman({ name: "x", capabilities: [], handlers: [] }), sessionId: "loop_abc", flush: async () => {}, end: async () => {}, stats: () => ({ queued: 0, sent: 0, dropped: 0, seq: 0 }) }
	const s = startCloudSession(() => [], {
		env,
		readCached: none,
		create: (c) => {
			configs.push(c)
			c.onSessionUrl?.("https://app.jigjoy.ai/?s=loop_abc")
			return fake
		},
		log: (l) => log.push(l),
	})
	assert.equal(s, fake)
	assert.equal(configs.length, 1)
	assert.equal(configs[0].projectKey, "mk_live_123")
	assert.equal(configs[0].mozaikVersion, "4.1.0")
	assert.equal(configs[0].endpoint, "https://api.app.jigjoy.ai")
	assert.equal(env.MOZAIK_API_KEY, "", "core's per-loop client now finds no key")
	assert.equal(env.MOZAIK_PROJECT_KEY, "")
	// Same line format as core's per-loop links, so the demo relay and the dashboard pick it up unchanged.
	assert.deepEqual(log, ["▶ mozaik cloud — watching live: https://app.jigjoy.ai/?s=loop_abc"])
})

test("the paired machine's cached key is used, and BRINGUP_CLOUD=off wins over any key", () => {
	const keys: string[] = []
	const fake = () => ({ participant: createHuman({ name: "x", capabilities: [], handlers: [] }), sessionId: "s", flush: async () => {}, end: async () => {}, stats: () => ({ queued: 0, sent: 0, dropped: 0, seq: 0 }) })
	startCloudSession(() => [], { env: {}, readCached: () => ({ projectKey: "mk_cached" }), create: (c) => (keys.push(c.projectKey), fake()), log: () => {} })
	assert.deepEqual(keys, ["mk_cached"])
	assert.equal(startCloudSession(() => [], { env: { BRINGUP_CLOUD: "off", MOZAIK_API_KEY: "k" }, readCached: none, create: fake, log: () => {} }), null)
})

test("the real exporter sends our events in one session (fake fetch, no network)", async () => {
	const s = new BringupState(tempDir())
	startRuntime(s, undefined, null)
	const bodies: string[] = []
	const fetch = (async (_url: string, init: { body: string }) => {
		bodies.push(init.body)
		return { status: 202, json: async () => ({}), text: async () => "" }
	}) as never
	const session = startCloudSession(() => state().getParticipants(), { env: { MOZAIK_API_KEY: "k" }, readCached: none, fetch, log: () => {} })!
	join(session.participant)
	const desk = createHuman({ name: "desk", capabilities: [], handlers: [] })
	join(desk)
	emit(makeEvent("design.settled", desk.getId(), { revision: 3, settled: true }), desk.getId())
	await session.end()
	await waitFor(() => bodies.length > 0)
	const sent = bodies.join("").trim().split("\n").map((l) => JSON.parse(l))
	const types = sent.map((e) => e.event.type)
	assert.equal(new Set(sent.map((e) => e.sessionId)).size, 1, "one session")
	assert.equal(types[0], "session.started")
	assert.ok(types.includes("design.settled"))
	assert.equal(types.at(-1), "session.ended")
})
