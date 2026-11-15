// Starter robots people can fork (src/dashboard/starters.ts, PlanStore.fork): a starter is an example plus its seed
// plan (examples/<name>/starter.json); a fork copies the seed into a new plan that remembers where it came from, and
// the starter file is never written.
import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { saveExample } from "../src/dashboard/examples.ts"
import { PlanStore } from "../src/dashboard/plans.ts"
import { serveHub, type HubLaunch } from "../src/dashboard/server.ts"
import { planChecks } from "../src/system/plan.ts"
import { tempDir, waitFor } from "./helpers.ts"
import { designResult, forksFile, recordForkBuild, setForkResult } from "../src/dashboard/starters.ts"

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

// ── Lineage: what each built fork changed and how it ended (<outRoot>/starters/<starter>/forks.jsonl) ──

const forks = (root: string, starter: string) => (existsSync(forksFile(root, starter)) ? readFileSync(forksFile(root, starter), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [])

test("a built fork gets one lineage record: its diff against the seed, then its result once the design ends", () => {
	const out = tempDir()
	const store = new PlanStore(out)
	const fork = store.fork("rover", examplesCopy())
	const edited = store.put(fork.id, { ...fork, briefs: { main: fork.briefs.main + "\n- A buzzer.\n" } }).plan
	const rec = recordForkBuild(out, edited, store.forkSeed(fork.id), `${fork.id}-free`)
	assert.ok(rec)
	const [line] = forks(out, "rover")
	assert.equal(line.planId, fork.id)
	assert.equal(line.design, `${fork.id}-free`)
	assert.equal(line.starterHash, fork.forkedFrom?.hash)
	assert.deepEqual(line.diff, { added: [], removed: [], changed: ["main"] })
	assert.equal(line.result, null)
	assert.ok(setForkResult(out, "rover", `${fork.id}-free`, { settled: true, findings: 0, status: "settled" }))
	assert.deepEqual(forks(out, "rover")[0].result, { settled: true, findings: 0, status: "settled" })
	assert.equal(setForkResult(out, "rover", `${fork.id}-free`, { settled: false, findings: 1, status: "x" }), false, "the first result stays")
	assert.equal(recordForkBuild(out, { ...edited, forkedFrom: undefined }, fork, "x"), null, "a plan that isn't a fork has no lineage")
	// No first version to diff against: the diff is unknown, never "no changes".
	recordForkBuild(out, edited, null, "y")
	assert.equal(forks(out, "rover")[1].diff, null)
	assert.match(forks(out, "rover")[1].diffUnknown, /history/)
})

test("a design's result: a system once its settle loop ended, a single board from its last design.settled", () => {
	const sys = tempDir()
	writeFileSync(join(sys, "system.json"), "{}")
	assert.equal(designResult(sys), null, "no state yet")
	writeFileSync(join(sys, "system-state.json"), JSON.stringify({ status: "round 1: findings sent to the boards", settled: false, findings: [{}] }))
	assert.equal(designResult(sys), null, "still working")
	writeFileSync(join(sys, "system-state.json"), JSON.stringify({ status: "settled: every board settled", settled: true, findings: [] }))
	assert.deepEqual(designResult(sys), { settled: true, findings: 0, status: "settled: every board settled" })
	const one = tempDir()
	assert.equal(designResult(one), null)
	writeFileSync(join(one, "trace.jsonl"), JSON.stringify({ type: "design.settled", payload: { revision: 3, settled: true } }) + "\n")
	assert.deepEqual(designResult(one), { settled: true, findings: null, status: "settled" })
})

// A hub whose launcher only makes the design folder; `end(code)` ends the process.
async function withForkHub(fn: (h: { url: string; root: string; end: (code: number) => void; hub: { close(): Promise<void> } }) => Promise<void>, root = tempDir()) {
	const ends: ((code: number) => void)[] = []
	const launch: HubLaunch = (args) => {
		mkdirSync(args.outDir, { recursive: true })
		return { done: new Promise((r) => ends.push((code) => r({ code, stderr: "" }))), kill: () => ends.at(-1)?.(143) }
	}
	const hub = await serveHub({ outRoot: root, port: 0, launch, examplesRoot: examplesCopyWithDuo() })
	let closed = false
	try {
		await fn({ url: hub.url, root, end: (code) => ends.at(-1)?.(code), hub: { close: async () => { closed = true; await hub.close() } } })
	} finally {
		if (!closed) await hub.close()
	}
}
// The shipped starters plus a two-board one, so a free try takes the system path.
function examplesCopyWithDuo(): string {
	const examples = examplesCopy()
	cpSync(join(EXAMPLES, "rover-climate"), join(examples, "rover-climate"), { recursive: true })
	return examples
}
const json = (url: string, body: object) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
const tryFree = async (url: string, id: string) => {
	const r = await json(`${url}/api/plans/${id}/build`, { mock: true, hardware: false, review: false })
	assert.equal(r.status, 201)
	const b = (await r.json()) as Any
	return (b.runId ?? b.systemId) as string
}
const traceLine = (dir: string, file: string, line: object) => appendFileSync(join(dir, file), JSON.stringify(line) + "\n")

test("Try for free on a one-board fork records the build, then the result from the run's design.settled", async () => {
	await withForkHub(async ({ url, root, end }) => {
		const { id } = (await (await post(`${url}/api/starters/rover/fork`)).json()) as Any
		const design = await tryFree(url, id)
		assert.equal(design, `${id}-free`)
		assert.equal(forks(root, "rover").length, 1)
		assert.equal(forks(root, "rover")[0].result, null)
		// The run settles and stays up: the record gets its result without waiting for Stop.
		traceLine(join(root, design), "trace.jsonl", { type: "design.settled", payload: { revision: 1, settled: true } })
		await waitFor(() => forks(root, "rover")[0].result !== null, 3000)
		assert.deepEqual(forks(root, "rover")[0].result, { settled: true, findings: null, status: "settled" })
		end(0)
		// A plain plan's build writes no lineage.
		const plain = (await (await json(`${url}/api/plans`, { sentence: "a logger", mock: true })).json()) as Any
		await tryFree(url, plain.id)
		assert.deepEqual(readdirSync(join(root, "plans", "starters")), ["rover"])
	})
})

test("Try for free on a two-board fork takes its result from the system's settled line and system-state.json", async () => {
	await withForkHub(async ({ url, root }) => {
		const { id } = (await (await post(`${url}/api/starters/rover-climate/fork`)).json()) as Any
		const design = await tryFree(url, id)
		const dir = join(root, design)
		writeFileSync(join(dir, "system-state.json"), JSON.stringify({ status: "round 1: findings sent to the boards", settled: false, findings: [{ a: 1 }] }))
		traceLine(dir, "system-trace.jsonl", { at: new Date().toISOString(), round: 1, board: "main", step: "request", status: "started" })
		await new Promise((r) => setTimeout(r, 600))
		assert.equal(forks(root, "rover-climate")[0].result, null, "a round is not the end")
		writeFileSync(join(dir, "system-state.json"), JSON.stringify({ status: "settled: every board settled", settled: true, findings: [] }))
		traceLine(dir, "system-trace.jsonl", { at: new Date().toISOString(), round: 1, board: "system", step: "settled", status: "ok", detail: "settled: every board settled" })
		await waitFor(() => forks(root, "rover-climate")[0].result !== null, 3000)
		assert.deepEqual(forks(root, "rover-climate")[0].result, { settled: true, findings: 0, status: "settled: every board settled" })
	})
})

test("a fork build whose process ends before it settles is recorded as stopped", async () => {
	await withForkHub(async ({ url, root, end }) => {
		const { id } = (await (await post(`${url}/api/starters/rover/fork`)).json()) as Any
		await tryFree(url, id)
		end(1)
		await waitFor(() => forks(root, "rover")[0].result !== null, 3000)
		assert.deepEqual(forks(root, "rover")[0].result, { settled: false, findings: null, status: "stopped before it settled (exit 1)" })
	})
})

test("closing the dashboard with a fork build pending records it as stopped, and a restart closes any record left open", async () => {
	const root = tempDir()
	await withForkHub(async ({ url, hub }) => {
		const { id } = (await (await post(`${url}/api/starters/rover/fork`)).json()) as Any
		await tryFree(url, id)
		await hub.close()
		assert.deepEqual(forks(root, "rover")[0].result, { settled: false, findings: null, status: "stopped: the dashboard closed before it settled" })
	}, root)
	// A record a crashed dashboard left open: settled meanwhile on disk, and one that never did.
	const file = forksFile(root, "rover")
	const open = (design: string) => JSON.stringify({ at: "x", planId: "plan-x", design, starterHash: "h", diff: null, result: null })
	mkdirSync(join(root, "done-run"))
	writeFileSync(join(root, "done-run", "trace.jsonl"), JSON.stringify({ type: "design.settled", payload: { revision: 2, settled: true } }) + "\n")
	appendFileSync(file, open("done-run") + "\n" + open("lost-run") + "\n")
	await withForkHub(async () => {
		const [, done, lost] = forks(root, "rover")
		assert.deepEqual(done.result, { settled: true, findings: null, status: "settled" })
		assert.deepEqual(lost.result, { settled: false, findings: null, status: "stopped: the dashboard restarted before it settled" })
	}, root)
})

test("the lineage stays out of the run and design listings", async () => {
	await withForkHub(async ({ url, root }) => {
		const { id } = (await (await post(`${url}/api/starters/rover/fork`)).json()) as Any
		const design = await tryFree(url, id)
		assert.ok(existsSync(forksFile(root, "rover")))
		const runs = (await (await fetch(`${url}/api/runs`)).json()) as Any[]
		const designs = (await (await fetch(`${url}/api/designs`)).json()) as Any[]
		assert.deepEqual(runs.map((r) => r.runId), [design])
		assert.ok(!designs.some((d) => /starters/.test(d.id)), JSON.stringify(designs.map((d) => d.id)))
	})
})

test("a malformed starter.json is a JSON error naming the file, and a seed's stray fields are not copied", async () => {
	const examples = examplesCopy()
	mkdirSync(join(examples, "broken"))
	writeFileSync(join(examples, "broken", "starter.json"), "[]")
	mkdirSync(join(examples, "notjson"))
	writeFileSync(join(examples, "notjson", "starter.json"), "{")
	const seed = JSON.parse(readFileSync(join(examples, "rover", "starter.json"), "utf8"))
	mkdirSync(join(examples, "stray"))
	writeFileSync(join(examples, "stray", "starter.json"), JSON.stringify({ ...seed, builtAs: "plan-old", version: 9 }))
	await withHub(examples, async ({ url }) => {
		for (const name of ["broken", "notjson"]) {
			const r = await post(`${url}/api/starters/${name}/fork`)
			assert.equal(r.status, 500)
			assert.match(r.headers.get("content-type") ?? "", /json/)
			assert.match(((await r.json()) as Any).error, new RegExp(`examples/${name}/starter.json`))
		}
		const r = await post(`${url}/api/starters/stray/fork`)
		assert.equal(r.status, 201)
		const v = (await (await fetch(`${url}/api/plans/${((await r.json()) as Any).id}`)).json()) as Any
		assert.equal(v.plan.builtAs, undefined)
		assert.equal(v.plan.version, 1)
	})
})

test("a plan save can't add, change or drop forkedFrom", async () => {
	await withHub(examplesCopy(), async ({ url }) => {
		const put = (id: string, plan: object) => fetch(`${url}/api/plans/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan }) })
		const { id } = (await (await post(`${url}/api/starters/rover/fork`)).json()) as Any
		const v = (await (await fetch(`${url}/api/plans/${id}`)).json()) as Any
		const origin = v.plan.forkedFrom
		const changed = (await (await put(id, { ...v.plan, forkedFrom: { starter: "other", hash: "x" } })).json()) as Any
		assert.deepEqual(changed.plan.forkedFrom, origin)
		const { forkedFrom: _f, ...dropped } = changed.plan
		assert.deepEqual(((await (await put(id, dropped)).json()) as Any).plan.forkedFrom, origin)
		const plain = (await (await json(`${url}/api/plans`, { sentence: "a logger", mock: true })).json()) as Any
		const pv = (await (await fetch(`${url}/api/plans/${plain.id}`)).json()) as Any
		const forged = (await (await put(plain.id, { ...pv.plan, forkedFrom: { starter: "rover", hash: "x" } })).json()) as Any
		assert.equal(forged.plan.forkedFrom, undefined)
	})
})

test("the fork route takes JSON only, and the list offers Fork only for a name the route accepts", async () => {
	const examples = examplesCopy()
	cpSync(join(examples, "rover"), join(examples, "Rover_2"), { recursive: true })
	writeFileSync(join(examples, "Rover_2", "example.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(examples, "rover", "example.json"), "utf8")), name: "Rover_2" }))
	await withHub(examples, async ({ url }) => {
		assert.equal((await fetch(`${url}/api/starters/rover/fork`, { method: "POST", headers: { "content-type": "text/plain" }, body: "x" })).status, 415)
		const list = (await (await fetch(`${url}/api/examples`)).json()) as Any[]
		assert.equal(list.find((e) => e.name === "rover").starter, true)
		assert.equal(list.filter((e) => e.starter).length, 1, "Rover_2 can't be forked by name, so it isn't offered")
	})
})

test("a robot example ships no case for boards on its chassis, and no board render (nothing reads it)", () => {
	const run = tempDir()
	writeFileSync(join(run, "system.json"), JSON.stringify({ name: "r", boards: [{ name: "main" }, { name: "climate" }], links: [], assembly: { body: "chassis", boards: [] } }))
	for (const b of ["main", "climate"]) {
		const bd = join(run, "boards", b)
		mkdirSync(join(bd, "board"), { recursive: true })
		mkdirSync(join(bd, "enclosure", "rev-1"), { recursive: true })
		writeFileSync(join(bd, "contract.json"), "{}")
		writeFileSync(join(bd, "board", "board.png"), "png")
		writeFileSync(join(bd, "enclosure", "rev-1", "case.stl"), "solid")
		writeFileSync(join(bd, "enclosure", "rev-1", "spec.json"), "{}")
	}
	const dest = tempDir()
	saveExample(run, "robot", "a robot", dest)
	assert.deepEqual(readdirSync(join(dest, "robot", "boards", "climate")), ["contract.json"])
})
