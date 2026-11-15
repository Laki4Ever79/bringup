// Plans on the hub (src/dashboard/plans.ts): a sentence becomes a plan, edits are versioned, a change in words returns
// what moved, and Build starts the existing system run (or a single board run for a one-board plan).
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
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

// A model key for real Builds (the launch is a stub: nothing calls a model).
const KEY = { OPENAI_API_KEY: "test-key" }

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
		const b = await send(`${url}/api/plans/${two.id}/build`, "POST", { mock: false, hardware: false, review: false })
		assert.equal(b.status, 201)
		const { systemId } = (await b.json()) as Any
		assert.equal(systemId, two.id, "Build keeps the plan id")
		assert.equal(calls[0].briefPath, "system")
		const specPath = calls[0].extraArgs![0]
		assert.equal(specPath, join(root, "plans", two.id, "system.json"))
		assert.equal(calls[0].outDir, join(root, two.id))
		assert.equal(JSON.parse(readFileSync(join(root, "plans", two.id, "plan.json"), "utf8")).builtAs, two.id)
		assert.ok(existsSync(join(root, "plans", two.id, "briefs", "beacon.md")))
		assert.deepEqual(JSON.parse(readFileSync(specPath, "utf8")).boards.map((x: Any) => x.brief), ["briefs/logger.md", "briefs/beacon.md"])
		const one = (await (await send(`${url}/api/plans`, "POST", { sentence: "a temperature logger", mock: true })).json()) as Any
		const r1 = (await (await send(`${url}/api/plans/${one.id}/build`, "POST", { mock: false, hardware: false, review: false })).json()) as Any
		assert.equal(r1.runId, one.id, "a one-board plan builds as a run with the plan id")
		assert.ok(!r1.systemId)
		assert.equal(calls[1].outDir, join(root, one.id))
		assert.notEqual(calls[1].briefPath, "system")
		assert.match(readFileSync(calls[1].briefPath, "utf8"), /climate logger/i)
	}, KEY)
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
		// CPU time, not wall-clock: the hub runs in this process, and other processes (the rest of the suite: builds, QEMU,
		// MuJoCo) stretch wall-clock time but not the work a save costs (pending-fixes, 11 Nov: p95 62.9 ms under load).
		const cpu = process.cpuUsage()
		for (let i = 0; i < 20; i++) {
			const r = (await (await send(`${url}/api/plans/${id}`, "PUT", { plan: { ...plan, layout: { ...plan.layout, extra: { x: i, y: i } } } })).json()) as Any
			plan = r.plan
		}
		const used = process.cpuUsage(cpu)
		const perSaveMs = (used.user + used.system) / 1000 / 20
		assert.ok(perSaveMs < 25, `${perSaveMs.toFixed(1)} ms of CPU per save (client and hub together)`)
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

// pending-fixes, 11 Nov: every drag appended the whole plan to history.jsonl. A move records only the positions; a change
// to the plan itself still records the whole plan, so the history can rebuild every version.
test("a drag records only the new positions in the plan's history; a real change records the whole plan", async () => {
	const root = tempDir()
	const hub = await serveHub({ outRoot: root, port: 0 })
	try {
		const url = hub.url
		const { id } = (await (await send(`${url}/api/plans`, "POST", { sentence: "a logger and a beacon over a cable", mock: true })).json()) as Any
		let { plan } = (await (await fetch(`${url}/api/plans/${id}`)).json()) as Any
		plan = ((await (await send(`${url}/api/plans/${id}`, "PUT", { plan: { ...plan, layout: { ...plan.layout, logger: { x: 5, y: 6 } } } })).json()) as Any).plan
		await send(`${url}/api/plans/${id}`, "PUT", { plan: { ...plan, why: "changed by hand" } })
		const lines = readFileSync(join(root, "plans", id, "history.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
		const [move, change] = lines.slice(-2)
		assert.deepEqual(Object.keys(move).sort(), ["at", "layout", "version"])
		assert.deepEqual(move.layout.logger, { x: 5, y: 6 })
		assert.equal(change.plan.why, "changed by hand")
	} finally {
		await hub.close()
	}
})

const until = async <T>(get: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> => {
	const end = Date.now() + ms
	for (;;) {
		const v = await get()
		if (ok(v) || Date.now() > end) return v
		await new Promise((r) => setTimeout(r, 100))
	}
}

test("a mock plan with a speaker learns the speaker and its amplifier, then can be built", async () => {
	await withHub(async ({ url, root, calls }) => {
		const { id } = (await (await send(`${url}/api/plans`, "POST", { sentence: "a talking clock with a speaker", mock: true })).json()) as Any
		const first = (await (await fetch(`${url}/api/plans/${id}`)).json()) as Any
		assert.deepEqual(first.plan.cantBuild, [], "a speaker is learnable, so not can't-build")
		assert.deepEqual(first.plan.needs.map((n: Any) => n.kind).sort(), ["amplifier", "speaker-driver"])
		const v = await until(
			async () => (await (await fetch(`${url}/api/plans/${id}`)).json()) as Any,
			(x) => x.learning?.every((l: Any) => l.status !== "learning"),
		)
		assert.deepEqual(v.learning.map((l: Any) => [l.need, l.status, l.mpn]).sort(), [
			["amplifier", "learned", "BRG-AMP1"],
			["speaker", "learned", "BRG-SPK40"],
		])
		assert.equal(v.learning.find((l: Any) => l.need === "speaker").reds, 1)
		assert.ok(existsSync(join(root, "plans", id, "learn.jsonl")))
		const b = await send(`${url}/api/plans/${id}/build`, "POST", { mock: true, hardware: false, review: false })
		assert.equal(b.status, 201)
		assert.equal(calls.length, 1)
	})
})

const mkPlan = async (url: string, sentence: string) => ((await (await send(`${url}/api/plans`, "POST", { sentence, mock: true })).json()) as Any).id as string

test("an unbuilt plan is listed under designs as \"plan, not built\"", async () => {
	await withHub(async ({ url, root }) => {
		const id = await mkPlan(url, "a logger and a beacon over a cable")
		const list = (await (await fetch(`${url}/api/designs`)).json()) as Any[]
		const d = list.find((x) => x.id === id)
		assert.ok(d)
		assert.equal(d.kind, "plan")
		assert.equal(d.status, "plan, not built")
		assert.equal(d.title, "a logger and a beacon over a cable")
		assert.deepEqual(await (await fetch(`${url}/api/runs`)).json(), [], "still not a run")
		await send(`${url}/api/plans/${id}/build`, "POST", { mock: false, hardware: false, review: false })
		writeFileSync(join(root, id, "system.json"), JSON.stringify({ name: "x", boards: [], links: [] })) // what the system run writes first
		const after = (await (await fetch(`${url}/api/designs`)).json()) as Any[]
		assert.equal(after.filter((x) => x.id === id).length, 1, "once built it is listed once")
		assert.notEqual(after.find((x) => x.id === id).kind, "plan")
	}, KEY)
})

test("GET /api/systems/<plan> returns the plan state with an assembly", async () => {
	await withHub(async ({ url }) => {
		const two = await mkPlan(url, "a logger and a beacon over a cable")
		const v = (await (await fetch(`${url}/api/systems/${two}`)).json()) as Any
		assert.equal(v.id, two)
		assert.equal(v.status, "plan")
		assert.equal(v.plan.plan.id, two)
		assert.deepEqual(v.spec.boards.map((b: Any) => b.name).sort(), ["beacon", "logger"])
		assert.deepEqual(v.assembly.boards.map((b: Any) => b.name).sort(), ["beacon", "logger"])
		assert.deepEqual(v.boards.map((b: Any) => [b.name, b.runId, b.status]).sort(), [["beacon", null, "plan"], ["logger", null, "plan"]])
		assert.deepEqual(Object.keys(v.facts.boards).sort(), ["beacon", "logger"])
		const one = await mkPlan(url, "a temperature logger")
		const o = (await (await fetch(`${url}/api/systems/${one}`)).json()) as Any
		assert.equal(o.status, "plan")
		assert.equal(o.assembly.boards.length, 1)
		assert.equal((await fetch(`${url}/api/systems/plan-nope`)).status, 404)
	})
})

test("/plan/<id> redirects to the design page", async () => {
	await withHub(async ({ url }) => {
		const id = await mkPlan(url, "a logger and a beacon over a cable")
		const r = await fetch(`${url}/plan/${id}`, { redirect: "manual" })
		assert.equal(r.status, 302)
		assert.equal(r.headers.get("location"), `/system?id=${id}`)
	})
})

test("building a plan keeps its id", async () => {
	await withHub(async ({ url, root }) => {
		const id = await mkPlan(url, "a logger and a beacon over a cable")
		const { systemId } = (await (await send(`${url}/api/plans/${id}/build`, "POST", { mock: false, hardware: false, review: false })).json()) as Any
		assert.equal(systemId, id)
		assert.ok(existsSync(join(root, "plans", id, "plan.json")), "the plan files stay put")
		assert.ok(existsSync(join(root, id)))
		assert.equal(((await (await fetch(`${url}/api/plans/${id}`)).json()) as Any).plan.id, id)
		// not yet writing system.json: starting, in the list and on the page
		assert.equal(((await (await fetch(`${url}/api/systems/${id}`)).json()) as Any).status, "starting")
		assert.equal(((await (await fetch(`${url}/api/designs`)).json()) as Any[]).find((x) => x.id === id).status, "starting")
		const one = await mkPlan(url, "a temperature logger")
		const { runId } = (await (await send(`${url}/api/plans/${one}/build`, "POST", { mock: false, hardware: false, review: false })).json()) as Any
		assert.equal(runId, one)
		assert.equal(((await (await fetch(`${url}/api/systems/${one}`)).json()) as Any).status, "starting")
		writeFileSync(join(root, one, "trace.jsonl"), "") // the run's first file
		assert.equal(((await (await fetch(`${url}/api/systems/${one}`)).json()) as Any).single, true)
		const body = await fetch(`${url}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ brief: "x", mock: true, id: "plan-hijack" }) })
		assert.notEqual(((await body.json()) as Any).runId, "plan-hijack", "the public route never takes an id")
	}, KEY)
})

test("an old plan address still opens the plan", async () => {
	await withHub(async ({ url, root }) => {
		const id = await mkPlan(url, "a logger and a beacon over a cable")
		// Built before ids were kept: its system.json exists in the plan folder, nothing names the system it became.
		writeFileSync(join(root, "plans", id, "system.json"), "{}")
		const r = await fetch(`${url}/plan/${id}`, { redirect: "manual" })
		assert.equal(r.status, 200)
		assert.match(await r.text(), /<html/i)
		// A plan that records where it was built leads there.
		const p = JSON.parse(readFileSync(join(root, "plans", id, "plan.json"), "utf8"))
		writeFileSync(join(root, "plans", id, "plan.json"), JSON.stringify({ ...p, builtAs: "system-20250101-abc" }))
		const r2 = await fetch(`${url}/plan/${id}`, { redirect: "manual" })
		assert.equal(r2.status, 302)
		assert.equal(r2.headers.get("location"), "/system?id=system-20250101-abc")
	})
})

test("a second Build of a built or building plan is refused with the link; a failed launch can be retried", async () => {
	await withHub(async ({ url, root }) => {
		const id = await mkPlan(url, "a logger and a beacon over a cable")
		const flags = { mock: false, hardware: false, review: false }
		assert.equal((await send(`${url}/api/plans/${id}/build`, "POST", flags)).status, 201)
		const again = await send(`${url}/api/plans/${id}/build`, "POST", flags)
		assert.equal(again.status, 409)
		assert.equal(((await again.json()) as Any).error, `this plan is already built: /system?id=${id}`)
		// A folder left empty by a launch that threw does not block Build, and the guard runs before anything is rewritten.
		const left = await mkPlan(url, "a logger and a beacon over a cable")
		mkdirSync(join(root, left), { recursive: true })
		assert.equal((await send(`${url}/api/plans/${left}/build`, "POST", flags)).status, 201)
		const built = await mkPlan(url, "a logger and a beacon over a cable")
		mkdirSync(join(root, built))
		writeFileSync(join(root, built, "system.json"), "{}")
		rmSync(join(root, "plans", built, "system.json"), { force: true })
		assert.equal((await send(`${url}/api/plans/${built}/build`, "POST", flags)).status, 409)
		assert.ok(!existsSync(join(root, "plans", built, "system.json")), "a refused Build writes nothing")
	}, KEY)
})

test("a multi-board plan built before ids were kept is not listed as a design of its own", async () => {
	await withHub(async ({ url, root }) => {
		const id = await mkPlan(url, "a logger and a beacon over a cable")
		writeFileSync(join(root, "plans", id, "system.json"), "{}")
		assert.ok(!((await (await fetch(`${url}/api/designs`)).json()) as Any[]).some((x) => x.id === id))
	})
})

test("an old single-board plan leads to the run made from its brief, the newest if several", async () => {
	await withHub(async ({ url, root }) => {
		const id = await mkPlan(url, "a temperature logger")
		const brief = ((await (await fetch(`${url}/api/plans/${id}`)).json()) as Any).plan.briefs.main ?? Object.values(((await (await fetch(`${url}/api/plans/${id}`)).json()) as Any).plan.briefs)[0]
		// Runs Build started after the plan was made (an old Build gave each run a new id).
		for (const [name, later] of [["20260101-aaa", 10], ["20260102-bbb", 100], ["other", 200]] as const) {
			mkdirSync(join(root, name), { recursive: true })
			writeFileSync(join(root, name, "brief.md"), name === "other" ? "something else\n" : brief + "\n")
			utimesSync(join(root, name, "brief.md"), new Date(Date.now() + later * 1000), new Date(Date.now() + later * 1000))
		}
		const r = await fetch(`${url}/plan/${id}`, { redirect: "manual" })
		assert.equal(r.status, 302)
		assert.equal(r.headers.get("location"), "/system?id=20260102-bbb")
	})
})

// Final review, Important 1: a new plan's address never leads to another design made from the same brief: not one
// built from another plan (out/plan-…), nor a run started before this plan existed.
test("a second plan from the same sentence opens its own page, not the first plan's design", async () => {
	await withHub(async ({ url, root }) => {
		const a = await mkPlan(url, "a temperature logger")
		const flags = { mock: false, hardware: false, review: false }
		assert.equal((await send(`${url}/api/plans/${a}/build`, "POST", flags)).status, 201)
		writeFileSync(join(root, a, "trace.jsonl"), "")
		const brief = readFileSync(join(root, a, "brief.md"), "utf8")
		// An old-style run of the same brief, made before plan B.
		mkdirSync(join(root, "20260101-old"), { recursive: true })
		writeFileSync(join(root, "20260101-old", "brief.md"), brief)
		utimesSync(join(root, "20260101-old", "brief.md"), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
		await new Promise((r) => setTimeout(r, 5))
		const b = await mkPlan(url, "a temperature logger")
		assert.notEqual(a, b)
		const r = await fetch(`${url}/plan/${b}`, { redirect: "manual" })
		assert.equal(r.status, 302)
		assert.equal(r.headers.get("location"), `/system?id=${b}`)
		const view = (await (await fetch(`${url}/api/systems/${b}`)).json()) as Any
		assert.equal(view.id, b)
		assert.equal(view.status, "plan")
	}, KEY)
})

// Final review, Important 3: "Try for free" (a scripted build) is a try, not the plan's build: it goes to
// <planId>-free (then -free-2, -free-3: each try is kept), is not recorded as builtAs, and is listed as its own design.
// The plan stays buildable with real models, under its own id.
test("a free try builds into <plan>-free, can be repeated, and the plan stays buildable for real", async () => {
	await withHub(async ({ url, root, calls }) => {
		const flags = { hardware: false, review: false }
		const one = await mkPlan(url, "a temperature logger")
		const t1 = (await (await send(`${url}/api/plans/${one}/build`, "POST", { mock: true, ...flags })).json()) as Any
		assert.equal(t1.runId, `${one}-free`)
		assert.equal(calls[0].outDir, join(root, `${one}-free`))
		writeFileSync(join(root, `${one}-free`, "trace.jsonl"), "")
		assert.equal(JSON.parse(readFileSync(join(root, "plans", one, "plan.json"), "utf8")).builtAs, undefined, "a try is not the plan's build")
		const t2 = await send(`${url}/api/plans/${one}/build`, "POST", { mock: true, ...flags })
		assert.equal(t2.status, 201, "a try can be repeated")
		assert.equal(((await t2.json()) as Any).runId, `${one}-free-2`)
		const designs = (await (await fetch(`${url}/api/designs`)).json()) as Any[]
		assert.ok(designs.some((d) => d.id === `${one}-free`), "the try is listed as its own design")
		assert.equal(designs.find((d) => d.id === one)?.status, "plan, not built", "the plan is still a plan")
		assert.equal(((await (await fetch(`${url}/api/systems/${one}`)).json()) as Any).status, "plan")
		const r = await fetch(`${url}/plan/${one}`, { redirect: "manual" })
		assert.equal(r.headers.get("location"), `/system?id=${one}`, "the plan's page is still the plan")
		const real = await send(`${url}/api/plans/${one}/build`, "POST", { mock: false, ...flags })
		assert.equal(real.status, 201)
		assert.equal(((await real.json()) as Any).runId, one, "a real Build keeps the plan id")
		assert.equal(JSON.parse(readFileSync(join(root, "plans", one, "plan.json"), "utf8")).builtAs, one)
		// A multi-board plan: the same, and its try does not make the plan look built before ids were kept.
		const two = await mkPlan(url, "a logger and a beacon over a cable")
		const s1 = (await (await send(`${url}/api/plans/${two}/build`, "POST", { mock: true, ...flags })).json()) as Any
		assert.equal(s1.systemId, `${two}-free`)
		assert.equal(calls.at(-1)!.outDir, join(root, `${two}-free`))
		writeFileSync(join(root, `${two}-free`, "system.json"), JSON.stringify({ name: "x", boards: [], links: [] }))
		assert.equal(((await (await fetch(`${url}/api/systems/${two}`)).json()) as Any).status, "plan")
		assert.ok(((await (await fetch(`${url}/api/designs`)).json()) as Any[]).some((d) => d.id === `${two}-free` && d.kind === "system"))
		const s2 = await send(`${url}/api/plans/${two}/build`, "POST", { mock: false, ...flags })
		assert.equal(s2.status, 201)
		assert.equal(((await s2.json()) as Any).systemId, two)
	}, { OPENAI_API_KEY: "test-key" })
})

// Review, Task 7: a build whose process died before writing the design is a plan again (not "starting" forever), and
// can be built again.
test("a build that exits without writing the design leaves the plan buildable, not starting", async () => {
	const root = tempDir()
	let launches = 0
	const launch: HubLaunch = () => {
		launches++
		return { done: Promise.resolve({ code: 1, stderr: "boom" }) }
	}
	const hub = await serveHub({ outRoot: root, port: 0, launch, planEnv: KEY })
	try {
		const id = ((await (await send(`${hub.url}/api/plans`, "POST", { sentence: "a logger and a beacon over a cable", mock: true })).json()) as Any).id
		const flags = { mock: false, hardware: false, review: false }
		assert.equal((await send(`${hub.url}/api/plans/${id}/build`, "POST", flags)).status, 201)
		await new Promise((r) => setTimeout(r, 20))
		assert.equal(((await (await fetch(`${hub.url}/api/systems/${id}`)).json()) as Any).status, "plan")
		assert.equal(((await (await fetch(`${hub.url}/api/designs`)).json()) as Any[]).find((x) => x.id === id).status, "plan, not built")
		assert.equal((await send(`${hub.url}/api/plans/${id}/build`, "POST", flags)).status, 201, "it can be built again")
		assert.equal(launches, 2)
	} finally {
		await hub.close()
	}
})
