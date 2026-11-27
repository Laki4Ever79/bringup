// Approve the plan before a paid run (src/system/plan-gate.ts; the user, 26 Nov 2026: "user should be presented the
// solution, so we are made sure they are happy with it").
import { test } from "node:test"
import assert from "node:assert/strict"
import { approveRunPlan, briefQuestions, cliPaidGate, makeRunPlan, paidStartRefusal, planText, readRunPlan } from "../src/system/plan-gate.ts"
import { tempDir } from "./helpers.ts"

function withHome(t: { after(fn: () => void): void }) {
	const home = process.env.BRINGUP_HOME
	process.env.BRINGUP_HOME = tempDir()
	t.after(() => (home === undefined ? delete process.env.BRINGUP_HOME : (process.env.BRINGUP_HOME = home)))
}

test("the brief's open questions are found in code: a full brief leaves none, a vague one names what the agents would assume", () => {
	const full = briefQuestions("# Brief: a greenhouse logger\nMeasures temperature and humidity indoors, 50 x 30 mm, on a 2000 mAh battery with USB-C charging.")
	assert.ok(full.every((q) => q.answered), JSON.stringify(full))
	const vague = briefQuestions("# Brief: a gadget\nSomething cool.")
	assert.deepEqual(vague.filter((q) => !q.answered).map((q) => q.topic), ["size", "power", "environment", "job"])
	assert.ok(vague.every((q) => q.answered || (q.assumption ?? "").length > 10))
})

test("a plan is free, kept, approved once, and only for the brief it was made for", (t) => {
	withHome(t)
	const p = makeRunPlan({ brief: "# Brief: a logger\nmeasures temperature" }, tempDir(), { OPENAI_API_KEY: "set" })
	assert.equal(p.planCostUsd, 0)
	assert.equal(p.provider, "openai")
	assert.match(planText(p), /Estimate: no estimate yet/)
	assert.match(planText(p), /isn't guaranteed to work/)
	assert.match(paidStartRefusal(undefined, "x") ?? "", /call plan_design first/)
	assert.match(paidStartRefusal(p.id, "# Brief: a logger\nmeasures temperature") ?? "", /isn't approved yet/)
	approveRunPlan(p.id)
	assert.equal(paidStartRefusal(p.id, "# Brief: a logger\nmeasures temperature\n"), null, "trailing whitespace is the same brief")
	assert.match(paidStartRefusal(p.id, "# Brief: a robot") ?? "", /different brief/)
	assert.equal(readRunPlan("../../etc/passwd"), null)
})

test("the CLI gate: a script without a terminal is refused unless it says --yes; a parent's approval carries to its board runs", async (t) => {
	withHome(t)
	const log: string[] = []
	const o = (argv: string[], env: Record<string, string | undefined> = {}, isTTY = false, answer = "") => ({ argv, outRoot: tempDir(), env, isTTY, ask: async () => answer, log: (s: string) => log.push(s) })
	const brief = "# Brief: a logger"
	const refused = await cliPaidGate({ brief }, brief, o([]))
	assert.ok("refused" in refused && /--yes/.test(refused.refused))
	assert.match(log.join("\n"), /Plan rp-/)
	const yes = await cliPaidGate({ brief }, brief, o(["--yes"]))
	assert.ok("planId" in yes && readRunPlan(yes.planId)?.approvedAt)
	const no = await cliPaidGate({ brief }, brief, o([], {}, true, "n"))
	assert.ok("refused" in no)
	const typedYes = await cliPaidGate({ brief }, brief, o([], {}, true, "y"))
	assert.ok("planId" in typedYes)
	const child = await cliPaidGate({ brief: "a board of the system" }, "a board of the system", o([], { BRINGUP_PLAN_APPROVED: (yes as { planId: string }).planId }))
	assert.deepEqual(child, yes)
	const named = await cliPaidGate({ brief }, brief, o(["--plan", (yes as { planId: string }).planId]))
	assert.deepEqual(named, yes)
})

test("a system's plan reads its boards' brief files, not their paths", (t) => {
	withHome(t)
	const p = makeRunPlan({ system: { name: "logger and beacon", boards: [{ name: "main", brief: "briefs/logger.md" }] } }, tempDir())
	assert.ok(p.questions.some((q) => q.answered), JSON.stringify(p.questions))
})
