import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Budget, BudgetExhausted } from "../src/learn/budget.ts"
import type { LearnDeps, LearnResult } from "../src/learn/learner.ts"
import { learnDepsFor, learnNeeds } from "../src/learn/runtime.ts"
import type { PartNeed } from "../src/learn/types.ts"
import { cantBuildFrom, scriptedPlan } from "../src/system/architect.ts"

const ROOT = resolve(import.meta.dirname, "..")
const need = (id: string, kind = "amplifier"): PartNeed => ({ id, role: kind, kind, requirements: "x" })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("needs are learned concurrently, each by its own participant", async () => {
	const started: string[] = []
	const finished: string[] = []
	const learn = async (n: PartNeed): Promise<LearnResult> => {
		started.push(n.id)
		await sleep(50)
		finished.push(n.id)
		return { status: "unavailable", reasons: [{ mpn: "", reason: "test" }] }
	}
	const updates: string[] = []
	const out = await learnNeeds([need("a"), need("b")], { deps: {} as LearnDeps, learn, onUpdate: (u) => updates.push(`${u.need}:${u.result ? "done" : "learning"}`) })
	assert.deepEqual(started, ["a", "b"])
	assert.equal(finished.length, 2)
	assert.ok(started.length === 2 && finished.indexOf("a") >= 0, "both started before either finished")
	assert.equal(out.size, 2)
	assert.deepEqual(updates.filter((u) => u.endsWith("learning")).sort(), ["a:learning", "b:learning"])
	assert.deepEqual(updates.filter((u) => u.endsWith("done")).sort(), ["a:done", "b:done"])
})

test("one budget for the whole run: the second need hits the cap the first used up", async () => {
	const budget = new Budget(1)
	const learn = async (n: PartNeed, deps: LearnDeps): Promise<LearnResult> => {
		if (n.id === "a") {
			deps.budget.charge(1, 1)
			return { status: "unavailable", reasons: [{ mpn: "A1", reason: "used it all" }] }
		}
		await sleep(20)
		if (!deps.budget.canSpend(0.01)) return { status: "unavailable", reasons: [{ mpn: "B1", reason: new BudgetExhausted(deps.budget.spent, deps.budget.cap) && "spending cap reached" }] }
		return { status: "unavailable", reasons: [{ mpn: "B1", reason: "should not get here" }] }
	}
	const out = await learnNeeds([need("a"), need("b")], { deps: { budget } as LearnDeps, learn, onUpdate: () => {} })
	const b = out.get("b")!
	assert.equal(b.status, "unavailable")
	if (b.status === "unavailable") assert.equal(b.reasons[0].reason, "spending cap reached")
})

test("in mock mode the synthetic speaker and amplifier are learned from their datasheets", async () => {
	const planDir = mkdtempSync(join(tmpdir(), "plan-"))
	const deps = learnDepsFor({}, ROOT, planDir, true)
	const out = await learnNeeds([need("spk", "speaker-driver"), need("amp")], { deps, onUpdate: () => {} })
	const spk = out.get("spk")!
	const amp = out.get("amp")!
	assert.equal(spk.status, "learned", JSON.stringify(spk))
	assert.equal(amp.status, "learned", JSON.stringify(amp))
	if (spk.status === "learned") {
		assert.equal(spk.part.mpn, "BRG-SPK40")
		assert.equal(spk.part.facts.find((f) => f.field === "outline")?.check, "two-reads")
		assert.equal(spk.part.facts.find((f) => f.field === "micKeepOutMm")?.status, "default")
	}
	if (amp.status === "learned") assert.equal(amp.part.mpn, "BRG-AMP1")
	assert.ok(!deps.root.startsWith(ROOT), "mock parts never go into the real catalog")
})

test("a speaker is no longer can't-build, a screen still is", () => {
	assert.deepEqual(cantBuildFrom("a clock with a speaker").map((c) => c.what), [])
	assert.deepEqual(cantBuildFrom("a clock with a screen").map((c) => c.what), ["a screen"])
})

test("the scripted architect lists a speaker and its amplifier as needs", () => {
	const p = scriptedPlan("a talking clock with a speaker")
	assert.deepEqual(p.needs?.map((n) => n.kind).sort(), ["amplifier", "speaker-driver"])
	assert.ok(p.needs?.every((n) => n.board === p.spec.boards[0].name))
	assert.deepEqual(scriptedPlan("a temperature logger").needs ?? [], [])
})

test("needs are only for kinds the hand catalog has no role for, never a chip", async () => {
	const { learnableKinds, validNeeds } = await import("../src/system/architect.ts")
	const k = learnableKinds()
	assert.ok(k.has("speaker-driver") && k.has("amplifier"))
	assert.ok(!k.has("sensor") && !k.has("mcu") && !k.has("ldo"))
	const spec = { name: "x", boards: [{ name: "clock", brief: "briefs/clock.md" }], links: [] }
	const needs = validNeeds([{ kind: "sensor", requirements: "CO2" }, { kind: "mcu", requirements: "bigger" }, { kind: "amplifier", requirements: "3 W" }], spec)
	assert.deepEqual(needs.map((n) => n.kind), ["amplifier", "speaker-driver"], "sensor and mcu dropped; the amplifier brings its speaker")
})

test("a can't-build line a need covers is dropped; others stay", async () => {
	const { dropCovered } = await import("../src/system/architect.ts")
	const needs = [{ id: "s", role: "speaker", kind: "speaker-driver", requirements: "x" }, { id: "a", role: "amp", kind: "amplifier", requirements: "y" }]
	const cant = [
		{ what: "A complete desk speaker that actually makes sound", reason: "The catalog has no speaker or audio amplifier" },
		{ what: "a screen", reason: "no such part" },
	]
	assert.deepEqual(dropCovered(cant, needs).map((c) => c.what), ["a screen"])
	assert.equal(dropCovered(cant, [needs[1]]).length, 2, "an amplifier alone doesn't cover the speaker")
})

test("a speaker need always comes with an amplifier need", async () => {
	const { validNeeds } = await import("../src/system/architect.ts")
	const spec = { name: "x", boards: [{ name: "main", brief: "briefs/main.md" }], links: [] }
	const needs = validNeeds([{ id: "audio1", kind: "speaker-driver", requirements: "40 mm, 8 ohm" }], spec)
	assert.deepEqual(needs.map((n) => n.kind), ["speaker-driver", "amplifier"])
	assert.equal(needs[1].board, "main")
	assert.deepEqual(validNeeds([{ kind: "speaker-driver", requirements: "a" }, { kind: "amplifier", requirements: "b" }], spec).map((n) => n.kind), ["speaker-driver", "amplifier"])
})

test("candidates are asked for by what the part is, not only its kind's name", async () => {
	const { candidatePrompt } = await import("../src/learn/runtime.ts")
	const p = candidatePrompt({ id: "s", role: "audio output", kind: "speaker-driver", requirements: "a small speaker" }, ROOT, ["X1"])
	assert.match(p, /loudspeaker: the cone-and-magnet transducer/)
	assert.match(p, /not an amplifier or driver IC/)
	assert.match(p, /Not these: X1/)
})

test("the architect is told what each learnable kind is", async () => {
	const { BUILDABLE } = await import("../src/system/architect.ts")
	assert.match(BUILDABLE, /speaker-driver \(a loudspeaker: the cone-and-magnet transducer/)
	assert.match(BUILDABLE, /amplifier \(an audio power amplifier IC/)
})

test("an amplifier need always comes with the speaker it drives", async () => {
	const { validNeeds } = await import("../src/system/architect.ts")
	const spec = { name: "x", boards: [{ name: "main", brief: "briefs/main.md" }], links: [] }
	assert.deepEqual(validNeeds([{ id: "amp1", kind: "amplifier", requirements: "drive a small passive loudspeaker" }], spec).map((n) => n.kind), ["amplifier", "speaker-driver"])
})

test("real learning traces every claim to the plan's claims.jsonl", async () => {
	const { readFileSync, existsSync } = await import("node:fs")
	const planDir = mkdtempSync(join(tmpdir(), "plan-"))
	const deps = learnDepsFor({}, ROOT, planDir, false)
	deps.onClaim?.({ need: "a", mpn: "X", page: 1, field: "f", value: 1, region: [0, 0, 0, 0], pass: "first", outcome: "text" })
	assert.ok(existsSync(join(planDir, "claims.jsonl")))
	assert.match(readFileSync(join(planDir, "claims.jsonl"), "utf8"), /"mpn":"X"/)
})
