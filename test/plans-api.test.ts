// Plans on the hub (src/dashboard/plans.ts): a sentence becomes a plan, edits are versioned, a change in words returns
// what moved, and Build starts the existing system run (or a single board run for a one-board plan).
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { serveHub, type HubLaunch } from "../src/dashboard/server.ts"
import { PublicGate } from "../src/dashboard/public.ts"
import { tempDir } from "./helpers.ts"
import { scriptedPlan } from "../src/system/architect.ts"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

async function withHub(fn: (h: { url: string; root: string; calls: Parameters<HubLaunch>[0][] }) => Promise<void>, planEnv: Record<string, string | undefined> = {}) {
	const root = tempDir()
	const calls: Parameters<HubLaunch>[0][] = []
	const launch: HubLaunch = (args) => {
		calls.push(args)
		return { done: new Promise(() => {}) }
	}
	const hub = await serveHub({ outRoot: root, port: 0, launch, planEnv })
	try {
		await fn({ url: hub.url, root, calls })
	} finally {
		await hub.close()
	}
}

const send = (url: string, method: string, body: object) => fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

test("a scripted plan is created, read with its checks and estimate, and stays out of the run list", async () => {
	await withHub(async ({ url }) => {
		const r = await send(`${url}/api/plans`, "POST", { sentence: "a logger and a beacon over a cable", mock: true })
		assert.equal(r.status, 201)
		const { id } = (await r.json()) as Any
		const v = (await (await fetch(`${url}/api/plans/${id}`)).json()) as Any
		assert.deepEqual(v.plan.spec.boards.map((b: Any) => b.name).sort(), ["beacon", "logger"])
		assert.deepEqual(v.issues, [])
		assert.ok("basis" in v.estimate)
		assert.deepEqual(await (await fetch(`${url}/api/runs`)).json(), [], "a plan is not a run")
		assert.deepEqual(await (await fetch(`${url}/api/systems`)).json(), [], "nor a system")
		assert.equal((await fetch(`${url}/plan/${id}`)).status, 200)
	})
})

test("an edit saved against an older version is refused, so a drag can't undo a newer change", async () => {
	await withHub(async ({ url }) => {
		const { id } = (await (await send(`${url}/api/plans`, "POST", { sentence: "a logger and a beacon over a cable", mock: true })).json()) as Any
		const { plan } = (await (await fetch(`${url}/api/plans/${id}`)).json()) as Any
		const moved = { ...plan, layout: { ...plan.layout, logger: { x: 300, y: 300 } } }
		const ok = await send(`${url}/api/plans/${id}`, "PUT", { plan: moved })
		assert.equal(ok.status, 200)
		assert.equal(((await ok.json()) as Any).plan.version, plan.version + 1)
		assert.equal((await send(`${url}/api/plans/${id}`, "PUT", { plan: moved })).status, 409)
	})
})

test("a change in words returns what moved", async () => {
	await withHub(async ({ url }) => {
		const { id } = (await (await send(`${url}/api/plans`, "POST", { sentence: "a logger and a beacon over a cable", mock: true })).json()) as Any
		const c = (await (await send(`${url}/api/plans/${id}/change`, "POST", { instruction: "remove beacon", mock: true })).json()) as Any
		assert.deepEqual(c.diff.removed, ["beacon", "L1"])
		assert.deepEqual(c.plan.spec.boards.map((b: Any) => b.name), ["logger"])
	})
})

test("Build starts the system run on the plan's own spec, or a board run for a one-board plan", async () => {
	await withHub(async ({ url, root, calls }) => {
		const two = (await (await send(`${url}/api/plans`, "POST", { sentence: "a logger and a beacon over a cable", mock: true })).json()) as Any
		const b = await send(`${url}/api/plans/${two.id}/build`, "POST", { mock: true, hardware: false, review: false })
		assert.equal(b.status, 201)
		const { systemId } = (await b.json()) as Any
		assert.match(systemId, /^system-/)
		assert.equal(calls[0].briefPath, "system")
		const specPath = calls[0].extraArgs![0]
		assert.equal(specPath, join(root, "plans", two.id, "system.json"))
		assert.ok(existsSync(join(root, "plans", two.id, "briefs", "beacon.md")))
		assert.deepEqual(JSON.parse(readFileSync(specPath, "utf8")).boards.map((x: Any) => x.brief), ["briefs/logger.md", "briefs/beacon.md"])
		const one = (await (await send(`${url}/api/plans`, "POST", { sentence: "a temperature logger", mock: true })).json()) as Any
		const r1 = (await (await send(`${url}/api/plans/${one.id}/build`, "POST", { mock: true, hardware: false, review: false })).json()) as Any
		assert.ok(r1.runId && !r1.systemId)
		assert.notEqual(calls[1].briefPath, "system")
		assert.match(readFileSync(calls[1].briefPath, "utf8"), /climate logger/i)
	})
})

test("without a model key a real plan says NO_KEY instead of hanging", async () => {
	await withHub(async ({ url }) => {
		const r = await send(`${url}/api/plans`, "POST", { sentence: "a logger", mock: false })
		assert.equal(r.status, 400)
		assert.equal(((await r.json()) as Any).code, "NO_KEY")
	})
})

test("plan checks answer fast enough to run on every drag", async () => {
	await withHub(async ({ url }) => {
		const { id } = (await (await send(`${url}/api/plans`, "POST", { sentence: "a logger and a beacon over a cable", mock: true })).json()) as Any
		let { plan } = (await (await fetch(`${url}/api/plans/${id}`)).json()) as Any
		plan = { ...plan, spec: { ...plan.spec, boards: [...plan.spec.boards, { name: "extra", brief: "briefs/extra.md" }] }, briefs: { ...plan.briefs, extra: "# Brief: extra\n" } }
		const times: number[] = []
		for (let i = 0; i < 20; i++) {
			const t = performance.now()
			const r = (await (await send(`${url}/api/plans/${id}`, "PUT", { plan: { ...plan, layout: { ...plan.layout, extra: { x: i, y: i } } } })).json()) as Any
			times.push(performance.now() - t)
			plan = r.plan
		}
		times.sort((a, b) => a - b)
		assert.ok(times[18] < 50, `p95 ${times[18].toFixed(1)} ms`)
	})
})

test("the public demo refuses to make plans", async () => {
	const hub = await serveHub({ outRoot: tempDir(), port: 0, public: { gate: new PublicGate(), briefPath: "briefs/logger.md" } })
	try {
		assert.equal((await send(`${hub.url}/api/plans`, "POST", { sentence: "x", mock: true })).status, 403)
	} finally {
		await hub.close()
	}
})

test("a typed change made against an older version is refused, so it can't undo a drag saved meanwhile", async () => {
	await withHub(async ({ url }) => {
		const { id } = (await (await send(`${url}/api/plans`, "POST", { sentence: "a logger and a beacon over a cable", mock: true })).json()) as Any
		const { plan } = (await (await fetch(`${url}/api/plans/${id}`)).json()) as Any
		assert.equal((await send(`${url}/api/plans/${id}`, "PUT", { plan: { ...plan, layout: { ...plan.layout, logger: { x: 5, y: 5 } } } })).status, 200)
		assert.equal((await send(`${url}/api/plans/${id}/change`, "POST", { instruction: "remove beacon", mock: true, version: plan.version })).status, 409)
	})
})

test("a drag save doesn't recompute the estimate (it reads every recorded run)", async () => {
	await withHub(async ({ url }) => {
		const { id } = (await (await send(`${url}/api/plans`, "POST", { sentence: "a logger and a beacon over a cable", mock: true })).json()) as Any
		const { plan } = (await (await fetch(`${url}/api/plans/${id}`)).json()) as Any
		const r = (await (await send(`${url}/api/plans/${id}`, "PUT", { plan })).json()) as Any
		assert.equal(r.estimate, undefined)
	})
})

test("the plan view says what planning spent: nothing for scripted, unknown (not free) for a real call without usage", async () => {
	await withHub(async ({ url }) => {
		const { id } = (await (await send(`${url}/api/plans`, "POST", { sentence: "a logger and a beacon over a cable", mock: true })).json()) as Any
		assert.deepEqual(((await (await fetch(`${url}/api/plans/${id}`)).json()) as Any).spend, { usd: null, calls: 0, unknownCalls: 0 })
	})
	const valid = { ...scriptedPlan("a logger and a beacon"), sentence: undefined, layout: undefined }
	const planFetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(valid) } }] }), { status: 200 })) as unknown as typeof fetch
	const hub = await serveHub({ outRoot: tempDir(), port: 0, planEnv: { OPENAI_API_KEY: "k" }, planFetch })
	try {
		const { id } = (await (await send(`${hub.url}/api/plans`, "POST", { sentence: "a logger and a beacon", mock: false })).json()) as Any
		assert.deepEqual(((await (await fetch(`${hub.url}/api/plans/${id}`)).json()) as Any).spend, { usd: null, calls: 1, unknownCalls: 1 })
	} finally {
		await hub.close()
	}
})

test("Build with real models and no key says NO_KEY instead of starting a run", async () => {
	await withHub(async ({ url, calls }) => {
		const { id } = (await (await send(`${url}/api/plans`, "POST", { sentence: "a logger and a beacon over a cable", mock: true })).json()) as Any
		const r = await send(`${url}/api/plans/${id}/build`, "POST", { mock: false, hardware: false, review: false })
		assert.equal(r.status, 400)
		assert.equal(((await r.json()) as Any).code, "NO_KEY")
		assert.equal(calls.length, 0)
	})
})
