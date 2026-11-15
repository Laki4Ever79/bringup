// Starter robots people can fork (src/dashboard/starters.ts, PlanStore.fork): a starter is an example plus its seed
// plan (examples/<name>/starter.json); a fork copies the seed into a new plan that remembers where it came from, and
// the starter file is never written.
import { test } from "node:test"
import assert from "node:assert/strict"
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { saveExample } from "../src/dashboard/examples.ts"
import { PlanStore } from "../src/dashboard/plans.ts"
import { serveHub, type HubLaunch } from "../src/dashboard/server.ts"
import { planChecks } from "../src/system/plan.ts"
import { tempDir } from "./helpers.ts"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

const EXAMPLES = resolve(import.meta.dirname, "..", "examples")

// A copy of the shipped examples, so a test can never write into the repo's.
function examplesCopy(): string {
	const root = tempDir()
	for (const name of ["rover"]) cpSync(join(EXAMPLES, name), join(root, name), { recursive: true })
	return root
}

test("the shipped rover starter is a valid one-board robot plan seeded from briefs/rover.md", () => {
	const seed = JSON.parse(readFileSync(join(EXAMPLES, "rover", "starter.json"), "utf8"))
	assert.equal(seed.robot, true)
	assert.deepEqual(seed.spec.boards.map((b: Any) => b.name), ["main"])
	assert.equal(seed.briefs.main, readFileSync(resolve(import.meta.dirname, "..", "briefs", "rover.md"), "utf8"))
	assert.deepEqual(planChecks({ ...seed, id: "plan-x", version: 1, spendUsd: null }), [])
})

test("a fork copies the seed's spec and briefs into a new plan with forkedFrom, and leaves the starter's bytes alone", () => {
	const examples = examplesCopy()
	const file = join(examples, "rover", "starter.json")
	const before = readFileSync(file)
	const store = new PlanStore(tempDir())
	const seed = JSON.parse(before.toString("utf8"))
	const plan = store.fork("rover", examples)
	assert.match(plan.id, /^plan-/)
	assert.equal(plan.version, 1)
	assert.deepEqual(plan.spec, seed.spec)
	assert.deepEqual(plan.briefs, seed.briefs)
	assert.equal(plan.sentence, seed.sentence)
	assert.equal(plan.robot, true)
	assert.equal(plan.forkedFrom?.starter, "rover")
	assert.match(plan.forkedFrom?.hash ?? "", /^[0-9a-f]{12}$/)
	assert.equal(plan.forkedFrom?.title, "Indoor rover")
	assert.deepEqual(readFileSync(file), before, "the starter is never written")
	assert.deepEqual(store.get(plan.id), plan)
})

test("the fork's first history line says where it came from", () => {
	const out = tempDir()
	const plan = new PlanStore(out).fork("rover", examplesCopy())
	const first = JSON.parse(readFileSync(join(out, "plans", plan.id, "history.jsonl"), "utf8").split("\n")[0])
	assert.equal(first.version, 1)
	assert.match(first.note, /forked from rover/)
	assert.deepEqual(first.plan.spec, plan.spec)
})

test("two forks of one starter are two plans", () => {
	const examples = examplesCopy()
	const store = new PlanStore(tempDir())
	const a = store.fork("rover", examples)
	const b = store.fork("rover", examples)
	assert.notEqual(a.id, b.id)
	assert.equal(a.forkedFrom?.hash, b.forkedFrom?.hash)
})

test("an unknown starter is a 404, a malformed name a 400, and a plain example (no seed) a 404", () => {
	const examples = examplesCopy()
	mkdirSync(join(examples, "plain"))
	writeFileSync(join(examples, "plain", "example.json"), "{}")
	const store = new PlanStore(tempDir())
	const status = (name: string) => {
		try {
			store.fork(name, examples)
			return 0
		} catch (e) {
			return (e as { status?: number }).status
		}
	}
	assert.equal(status("nope"), 404)
	assert.equal(status("plain"), 404)
	assert.equal(status("../rover"), 400)
	assert.equal(status("Rover"), 400)
	assert.equal(status(""), 400)
})

test("a change in words on a fork (scripted) gives a diff against the seed, and the fork keeps its origin", async () => {
	const examples = examplesCopy()
	// A two-board seed, so the scripted architect's one change ("remove <board>") has something to remove.
	const seed = JSON.parse(readFileSync(join(examples, "rover", "starter.json"), "utf8"))
	seed.spec.boards.push({ name: "climate", brief: "briefs/climate.md" })
	seed.spec.links.push({ id: "L1", kind: "uart", a: { board: "main" }, b: { board: "climate" }, baud: 115200, cable: { lengthMm: 300 } })
	seed.briefs.climate = "# Brief: climate\n\nA temperature and humidity board."
	seed.layout.climate = { x: 400, y: 120 }
	mkdirSync(join(examples, "duo"))
	writeFileSync(join(examples, "duo", "example.json"), JSON.stringify({ name: "duo", title: "Duo", sentence: seed.sentence, boards: [], links: [] }))
	writeFileSync(join(examples, "duo", "starter.json"), JSON.stringify(seed))
	const store = new PlanStore(tempDir())
	const fork = store.fork("duo", examples)
	const changed = await store.change(fork.id, "remove climate", true)
	assert.deepEqual(changed.diff.removed, ["climate", "L1"])
	assert.deepEqual(store.forkSeed(fork.id)?.spec, seed.spec, "the seed is the fork's first version")
	assert.deepEqual(changed.plan.forkedFrom, fork.forkedFrom, "a change keeps where the plan came from")
})

async function withHub(examples: string, fn: (h: { url: string; root: string; calls: Parameters<HubLaunch>[0][] }) => Promise<void>) {
	const root = tempDir()
	const calls: Parameters<HubLaunch>[0][] = []
	const launch: HubLaunch = (args) => {
		calls.push(args)
		return { done: new Promise(() => {}) }
	}
	const hub = await serveHub({ outRoot: root, port: 0, launch, examplesRoot: examples })
	try {
		await fn({ url: hub.url, root, calls })
	} finally {
		await hub.close()
	}
}

const post = (url: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })

test("POST /api/starters/<name>/fork makes a plan and answers its page; unknown 404, malformed 400", async () => {
	await withHub(examplesCopy(), async ({ url, root }) => {
		const r = await post(`${url}/api/starters/rover/fork`)
		assert.equal(r.status, 201)
		const body = (await r.json()) as Any
		assert.match(body.id, /^plan-/)
		assert.equal(body.url, `/plan/${body.id}`)
		assert.ok(existsSync(join(root, "plans", body.id, "plan.json")))
		const v = (await (await fetch(`${url}/api/plans/${body.id}`)).json()) as Any
		assert.equal(v.plan.forkedFrom.starter, "rover")
		assert.equal((await post(`${url}/api/starters/nope/fork`)).status, 404)
		assert.equal((await post(`${url}/api/starters/Bad.Name/fork`)).status, 400)
		assert.equal((await post(`${url}/api/starters/..%2Frover/fork`)).status, 400)
	})
})

test("GET /api/examples marks the examples that have a starter", async () => {
	const examples = examplesCopy()
	mkdirSync(join(examples, "plain"))
	writeFileSync(join(examples, "plain", "example.json"), JSON.stringify({ name: "plain", title: "Plain", sentence: "s", boards: [], links: [] }))
	await withHub(examples, async ({ url }) => {
		const list = (await (await fetch(`${url}/api/examples`)).json()) as Any[]
		assert.equal(list.find((e) => e.name === "rover").starter, true)
		assert.equal(list.find((e) => e.name === "plain").starter, undefined)
	})
})

test("re-saving an example keeps its starter seed", () => {
	const examples = examplesCopy()
	const before = readFileSync(join(examples, "rover", "starter.json"))
	const run = tempDir()
	writeFileSync(join(run, "brief.md"), "# Brief: indoor rover\n")
	saveExample(run, "rover", "a rover", examples)
	assert.deepEqual(readFileSync(join(examples, "rover", "starter.json")), before)
})

test("the shipped Rover + climate starter is the two-board robot of briefs/systems/rover-climate.json, and forks over the API", async () => {
	const seed = JSON.parse(readFileSync(join(EXAMPLES, "rover-climate", "starter.json"), "utf8"))
	const spec = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "briefs", "systems", "rover-climate.json"), "utf8"))
	assert.equal(seed.robot, true)
	assert.deepEqual(seed.spec.boards.map((b: Any) => b.name), ["main", "climate"])
	assert.deepEqual(seed.spec.links, spec.links)
	assert.equal(seed.briefs.main, readFileSync(resolve(import.meta.dirname, "..", "briefs", "rover.md"), "utf8"))
	assert.equal(seed.briefs.climate, readFileSync(resolve(import.meta.dirname, "..", "briefs", "logger.md"), "utf8"))
	assert.deepEqual(planChecks({ ...seed, id: "plan-x", version: 1, spendUsd: null }), [])
	const examples = examplesCopy()
	cpSync(join(EXAMPLES, "rover-climate"), join(examples, "rover-climate"), { recursive: true })
	await withHub(examples, async ({ url }) => {
		const r = await post(`${url}/api/starters/rover-climate/fork`)
		assert.equal(r.status, 201)
		const { id } = (await r.json()) as Any
		const v = (await (await fetch(`${url}/api/plans/${id}`)).json()) as Any
		assert.deepEqual(v.plan.forkedFrom.title, "Rover + climate board")
		assert.deepEqual(v.issues, [])
	})
})

test("a system example keeps its assembly, so the start page stands a robot's boards on its chassis", () => {
	const meta = JSON.parse(readFileSync(join(EXAMPLES, "rover-climate", "example.json"), "utf8"))
	assert.equal(meta.assembly.body, "chassis")
	assert.deepEqual(meta.assembly.boards.map((b: Any) => b.name).sort(), ["climate", "main"])
})
