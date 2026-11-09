// The system architect (src/system/architect.ts): a sentence becomes a plan of boards, cables and briefs; the free plan
// checks (src/system/plan.ts) flag problems before anything is built.
import { test } from "node:test"
import assert from "node:assert/strict"
import { NoModelKey } from "../src/dashboard/ask.ts"
import { PlanInvalid, proposePlan, scriptedPlan } from "../src/system/architect.ts"
import { planChecks, type Plan } from "../src/system/plan.ts"

const asPlan = (p: ReturnType<typeof scriptedPlan>): Plan => ({ ...p, id: "p1", version: 1, spendUsd: null })

test("the scripted architect splits a logger and a beacon into two boards on one UART cable, with no issues", () => {
	const p = scriptedPlan("a logger and a beacon that share readings over a cable")
	assert.deepEqual(p.spec.boards.map((b) => b.name).sort(), ["beacon", "logger"])
	assert.deepEqual(p.spec.links.map((l) => l.kind), ["uart"])
	assert.deepEqual(Object.keys(p.briefs).sort(), ["beacon", "logger"])
	assert.match(p.briefs.logger, /climate logger/i)
	assert.deepEqual(planChecks(asPlan(p)), [])
})

test("a one-device sentence gets one board and no cables", () => {
	const p = scriptedPlan("a temperature logger")
	assert.equal(p.spec.boards.length, 1)
	assert.equal(p.spec.links.length, 0)
	assert.deepEqual(planChecks(asPlan(p)), [])
})

test("what the pipeline can't build is listed with a reason, not dropped", () => {
	const p = scriptedPlan("a rover with two motors that avoids walls")
	const motor = p.cantBuild.find((c) => /motor/i.test(c.what))
	assert.ok(motor, "motors are named")
	assert.match(motor.reason, /mechanics/)
})

test("the plan checks flag an I2C cable too long for its bus and a board connected to nothing", () => {
	const p = asPlan(scriptedPlan("a logger and a beacon that share readings over a cable"))
	const i2c: Plan = {
		...p,
		spec: { ...p.spec, links: [{ id: "L1", kind: "i2c", a: { board: "logger" }, b: { board: "beacon" }, i2c: { controller: "logger", targets: { beacon: 0x42 }, pullupsOn: "logger" }, cable: { lengthMm: 5000 } }] },
	}
	const long = planChecks(i2c)
	assert.equal(long.length, 1)
	assert.equal(long[0].target.link, "L1")
	assert.match(long[0].message, /mm of cable/)
	const lonely = planChecks({ ...p, spec: { ...p.spec, links: [] } })
	assert.deepEqual(lonely.map((i) => i.target.board).sort(), ["beacon", "logger"])
})

test("the plan checks flag two I2C targets at one address on the same controller", () => {
	const p = asPlan(scriptedPlan("a logger and a beacon that share readings over a cable"))
	const three: Plan = {
		...p,
		spec: {
			...p.spec,
			boards: [...p.spec.boards, { name: "extra", brief: "briefs/extra.md" }],
			links: [
				{ id: "L1", kind: "i2c", a: { board: "logger" }, b: { board: "beacon" }, i2c: { controller: "logger", targets: { beacon: 0x42 }, pullupsOn: "logger" }, cable: { lengthMm: 200 } },
				{ id: "L2", kind: "i2c", a: { board: "logger" }, b: { board: "extra" }, i2c: { controller: "logger", targets: { extra: 0x42 }, pullupsOn: "logger" }, cable: { lengthMm: 200 } },
			],
		},
		briefs: { ...p.briefs, extra: "# Brief: extra\n" },
	}
	const clash = planChecks(three)
	assert.equal(clash.length, 1)
	assert.match(clash[0].message, /0x42/)
})

function fakeFetch(bodies: unknown[]) {
	let calls = 0
	const f = (async () => {
		const content = JSON.stringify(bodies[Math.min(calls++, bodies.length - 1)])
		return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }), { status: 200 })
	}) as unknown as typeof fetch
	return { f, calls: () => calls }
}

const valid = (() => {
	const p = scriptedPlan("a logger and a beacon that share readings over a cable")
	return { spec: p.spec, briefs: p.briefs, why: "Two devices.", offBoard: [], cantBuild: [], optional: [] }
})()

test("a real architect answer that fails validation is retried once with the errors, then accepted", async () => {
	const bad = { ...valid, spec: { ...valid.spec, links: [{ ...valid.spec.links[0], b: { board: "nope" } }] } }
	const { f, calls } = fakeFetch([bad, valid])
	const p = await proposePlan({ sentence: "a logger and a beacon" }, { mock: false, env: { OPENAI_API_KEY: "k" }, fetchImpl: f })
	assert.equal(calls(), 2)
	assert.deepEqual(p.spec.boards.map((b) => b.name).sort(), ["beacon", "logger"])
})

test("an answer still invalid after the retry is reported, not built", async () => {
	const bad = { ...valid, spec: { ...valid.spec, links: [{ ...valid.spec.links[0], b: { board: "nope" } }] } }
	const { f } = fakeFetch([bad])
	await assert.rejects(proposePlan({ sentence: "x" }, { mock: false, env: { OPENAI_API_KEY: "k" }, fetchImpl: f }), PlanInvalid)
})

test("without a model key the real architect says so", async () => {
	await assert.rejects(proposePlan({ sentence: "x" }, { mock: false, env: {}, fetchImpl: fakeFetch([valid]).f }), NoModelKey)
})

test("board names must be plain lower-case ids, so a name can't reach outside the plan folder or break a run id", () => {
	const p = asPlan(scriptedPlan("a logger and a beacon that share readings over a cable"))
	for (const bad of ["../../tmp/x", "Sensor Hub", "sensor/hub"]) {
		const q: Plan = { ...p, spec: { ...p.spec, boards: [...p.spec.boards, { name: bad, brief: `briefs/${bad}.md` }] }, briefs: { ...p.briefs, [bad]: "# Brief: x\n" } }
		assert.ok(planChecks(q).some((i) => i.target.board === bad && /lower-case/.test(i.message)), bad)
	}
})

test("the real architect keeps what can't be built even when the model leaves it out", async () => {
	const { f } = fakeFetch([valid])
	const p = await proposePlan({ sentence: "a rover with two motors" }, { mock: false, env: { OPENAI_API_KEY: "k" }, fetchImpl: f })
	assert.ok(p.cantBuild.some((c) => /motor/.test(c.what)))
})

test("a real architect answer with a bad board name is retried", async () => {
	const bad = { ...valid, spec: { ...valid.spec, boards: [{ name: "Sensor Hub" }, ...valid.spec.boards] }, briefs: { ...valid.briefs, "Sensor Hub": "# x\n" } }
	const { f, calls } = fakeFetch([bad, valid])
	await proposePlan({ sentence: "x" }, { mock: false, env: { OPENAI_API_KEY: "k" }, fetchImpl: f })
	assert.equal(calls(), 2)
})
