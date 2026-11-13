import { test } from "node:test"
import assert from "node:assert/strict"
import { cpSync, existsSync, mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"

import { join, resolve } from "node:path"
import { Budget, BudgetedReader } from "../src/learn/budget.ts"
import { learnedDir, readLearned } from "../src/learn/catalog.ts"
import { createDocStore } from "../src/learn/docs.ts"
import type { Distributor } from "../src/learn/distributors.ts"
import { learnPart, type LearnDeps, type LearnLog } from "../src/learn/learner.ts"
import type { Fact, PartNeed } from "../src/learn/types.ts"
import { fixtureFetch } from "./fixtures/learn/fetch.ts"
import { fakeReader } from "./fixtures/learn/reader.ts"

const ROOT = resolve(import.meta.dirname, "..")
const row = (y: number): [number, number, number, number] => [0.4, (y - 12) / 792, 0.4, 20 / 792]
const line = (y: number): [number, number, number, number] => [0.05, (y - 14) / 792, 0.9, 24 / 792]
// The cheap model reads BRG-AMP1's datasheet correctly: every critical fact but the footprint (which comes from the
// footprint search) is on its pages.
const AMP_SCRIPT = {
	first: {
		1: {
			supplyRange: { value: [2.5, 5.5], unit: "V", region: row(140) },
			supplyMaxV: { value: 6, unit: "V", region: row(160) },
			minLoadOhm: { value: 4, unit: "Ω", region: row(180) },
			outputPowerW: { value: 3.2, unit: "W", region: row(200) },
			interface: { value: "I2S", region: row(240) },
		},
		2: {
			pins: { value: "1 SD, 2 GAIN, 3 DIN, 4 BCLK, 5 LRCLK, 6 GND, 7 VDD, 8 OUTP, 9 OUTN, 10 GND", region: line(90) },
			outline: { value: [3, 3], unit: "mm", region: line(130) },
			height: { value: 0.75, unit: "mm", region: line(130) },
		},
	},
}
const NEED: PartNeed = { id: "n1", role: "amplifier", kind: "amplifier", requirements: "I2S class-D, 3 W into 4 ohm" }
const FOOTPRINT: Fact = { field: "footprint", value: "easyeda:C999001", status: "datasheet", critical: true, check: "pad-count" }

function setup(opts: { cap?: number; footprintFor?: (mpn: string) => Fact | null; candidates?: string[] } = {}) {
	const root = mkdtempSync(join(tmpdir(), "learner-"))
	mkdirSync(join(root, "catalog"), { recursive: true })
	cpSync(join(ROOT, "catalog/kinds"), join(root, "catalog/kinds"), { recursive: true })
	const ff = fixtureFetch()
	const store = createDocStore(root, ff.fetch)
	const fake = fakeReader(AMP_SCRIPT, 0.002)
	const budget = new Budget(opts.cap ?? 2)
	const listing = (mpn: string) => ({ distributor: "lcsc", mpn, sku: "C999001", stock: 500, priceUsd: 0.4, assemblerStocked: true, datasheetUrl: "https://example.com/brg-amp1.pdf", package: "QFN-10" })
	const dist: Distributor = { name: "lcsc", lookup: async (mpn) => listing(mpn) }
	const logs: LearnLog[] = []
	const proposed: string[][] = []
	const deps: LearnDeps = {
		root,
		store,
		reader: new BudgetedReader(fake.reader, budget),
		budget,
		distributors: [dist],
		webFind: async () => null,
		footprint: async (p) => (opts.footprintFor ? opts.footprintFor(p.mpn) : FOOTPRINT),
		propose: async (_need, exclude) => {
			proposed.push(exclude)
			return opts.candidates ?? ["BRG-AMP1", "BRG-AMP2", "BRG-AMP3"]
		},
		log: (l) => logs.push(l),
	}
	return { root, deps, calls: fake.calls, logs, budget, proposed }
}

test("the first good candidate is learned and written", async () => {
	const s = setup()
	const r = await learnPart(NEED, s.deps)
	assert.equal(r.status, "learned")
	if (r.status !== "learned") return
	assert.equal(r.part.mpn, "BRG-AMP1")
	assert.equal(r.reused, false)
	assert.equal(r.part.placement, "board")
	assert.ok(r.part.facts.some((f) => f.field === "footprint"))
	assert.ok(r.part.costUsd > 0)
	assert.deepEqual(readLearned(s.root).map((p) => p.mpn), ["BRG-AMP1"])
})

test("a missing critical fact switches to the next candidate, with the reason kept", async () => {
	const s = setup({ footprintFor: (mpn) => (mpn === "BRG-AMP1" ? null : FOOTPRINT) })
	const r = await learnPart(NEED, s.deps)
	assert.equal(r.status, "learned")
	if (r.status !== "learned") return
	assert.equal(r.part.mpn, "BRG-AMP2")
	assert.deepEqual(readLearned(s.root).map((p) => p.mpn), ["BRG-AMP2"])
	assert.match(s.logs.find((l) => l.mpn === "BRG-AMP1")!.outcome, /missing critical: footprint/)
})

test("three failures make the part unavailable, each with its reason", async () => {
	const s = setup({ footprintFor: () => null })
	const r = await learnPart(NEED, s.deps)
	assert.equal(r.status, "unavailable")
	if (r.status !== "unavailable") return
	assert.deepEqual(r.reasons.map((x) => x.mpn), ["BRG-AMP1", "BRG-AMP2", "BRG-AMP3"])
	assert.ok(r.reasons.every((x) => /footprint/.test(x.reason)))
	assert.deepEqual(readLearned(s.root), [])
})

test("the cap reached mid-part writes nothing", async () => {
	const s = setup({ cap: 0.01 })
	const r = await learnPart(NEED, s.deps)
	assert.equal(r.status, "unavailable")
	if (r.status !== "unavailable") return
	assert.equal(r.reasons.at(-1)!.reason, "spending cap reached")
	assert.ok(!existsSync(learnedDir(s.root)) || readLearned(s.root).length === 0)
})

test("an already learned part is reused without reading anything", async () => {
	const s = setup()
	await learnPart(NEED, s.deps)
	const before = s.calls.length
	const again = await learnPart(NEED, s.deps)
	assert.equal(again.status, "learned")
	if (again.status === "learned") assert.equal(again.reused, true)
	assert.equal(s.calls.length, before)
})

test("the same mpn is learned once by two concurrent learners", async () => {
	const s = setup()
	const [a, b] = await Promise.all([learnPart(NEED, s.deps), learnPart({ ...NEED, id: "n2" }, s.deps)])
	assert.equal(a.status, "learned")
	assert.equal(b.status, "learned")
	const firstReads = s.calls.filter((c) => c.meta.pass === "first").length
	assert.equal(firstReads, 2, "one learner read the two pages; the other waited and reused")
	assert.equal([a, b].filter((r) => r.status === "learned" && r.reused).length, 1)
})

test("one log line per candidate tried", async () => {
	const s = setup({ footprintFor: (mpn) => (mpn === "BRG-AMP3" ? FOOTPRINT : null) })
	await learnPart(NEED, s.deps)
	assert.deepEqual(s.logs.map((l) => [l.mpn, l.outcome === "learned"]), [
		["BRG-AMP1", false],
		["BRG-AMP2", false],
		["BRG-AMP3", true],
	])
	const l = s.logs[2]
	assert.equal(l.need, "n1")
	assert.equal(l.pages, 2)
	assert.ok(l.calls >= 2)
	assert.deepEqual(l.models, ["gpt-5.4-mini"])
	assert.ok(l.facts >= 8)
})

test("the datasheet's package name feeds the footprint search when no listing names one", async () => {
	const s = setup()
	const seen: (string | undefined)[] = []
	s.deps.distributors = [{ name: "x", lookup: async (mpn) => ({ distributor: "x", mpn, stock: 5, priceUsd: 1, assemblerStocked: true, datasheetUrl: "https://example.com/brg-amp1.pdf" }) }]
	s.deps.footprint = async (p) => {
		seen.push(p.packageName)
		return FOOTPRINT
	}
	const { fakeReader } = await import("./fixtures/learn/reader.ts")
	const { BudgetedReader } = await import("../src/learn/budget.ts")
	const withPackage = { first: { ...AMP_SCRIPT.first, 2: { ...AMP_SCRIPT.first[2], package: { value: "QFN-10", region: line(130) } } } }
	s.deps.reader = new BudgetedReader(fakeReader(withPackage).reader, s.budget)
	await learnPart(NEED, s.deps)
	assert.deepEqual(seen, ["QFN-10"])
})

test("a model error on one candidate moves on to the next", async () => {
	const s = setup()
	const inner = s.deps.reader
	let failed = false
	s.deps.reader = {
		async read(req) {
			if (!failed) {
				failed = true
				throw new Error("gpt-5.4-mini: HTTP 500")
			}
			return inner.read(req)
		},
	}
	const r = await learnPart(NEED, s.deps)
	assert.equal(r.status, "learned")
	if (r.status === "learned") assert.equal(r.part.mpn, "BRG-AMP2")
	assert.match(s.logs[0].outcome, /HTTP 500/)
})

test("'no datasheet found' says what the web search came back with", async () => {
	const s = setup({ candidates: ["BRG-NONE"] })
	s.deps.distributors = []
	s.deps.webFind = async () => ({ missed: "2 links, none named the part" })
	const r = await learnPart(NEED, s.deps)
	assert.equal(r.status, "unavailable")
	if (r.status === "unavailable") assert.equal(r.reasons[0].reason, "no datasheet found (no distributor listing; web search: 2 links, none named the part)")
})

test("a candidate whose datasheet is for another kind of part ends after one read of page 1", async () => {
	const s = setup({ candidates: ["BRG-AMP1"] })
	const inner = s.deps.reader
	const passes: string[] = []
	s.deps.reader = { read: async (req) => (passes.push(req.meta.pass), req.meta.pass === "identify" ? { json: { matches: false, part: "a piezo buzzer" }, usd: 0.0005 } : inner.read(req)) }
	const r = await learnPart(NEED, s.deps)
	assert.equal(r.status, "unavailable")
	if (r.status === "unavailable") assert.match(r.reasons[0].reason, /datasheet is for a piezo buzzer, not/)
	assert.deepEqual(passes, ["identify"])
	assert.equal(s.logs[0].calls, 1)
})

test("every candidate's log line says how many facts the cheap model's first read gave, learned or not", async () => {
	const s = setup({ candidates: ["BRG-AMP1"], footprintFor: () => null })
	const r = await learnPart(NEED, s.deps)
	assert.equal(r.status, "unavailable", "no footprint, so not learned")
	assert.ok(s.logs[0].firstReadMatched >= 8, JSON.stringify(s.logs[0]))
	assert.equal(s.logs[0].pages, 2)
})

test("the footprint search gets the body size the datasheet gave", async () => {
	const s = setup({ candidates: ["BRG-AMP1"] })
	const asked: { bodyMm?: number[] }[] = []
	s.deps.footprint = async (p) => (asked.push(p), FOOTPRINT)
	await learnPart(NEED, s.deps)
	assert.deepEqual(asked[0].bodyMm, [3, 3])
})

test("every claim read is traced with its need and part number", async () => {
	const s = setup({ candidates: ["BRG-AMP1"] })
	const traced: { need: string; mpn: string; field: string }[] = []
	s.deps.onClaim = (t) => traced.push(t)
	await learnPart(NEED, s.deps)
	assert.ok(traced.some((t) => t.need === "n1" && t.mpn === "BRG-AMP1" && t.field === "supplyRange"))
})

test("a proposed datasheet link is used when the PDF names the part, without a web search", async () => {
	const s = setup()
	s.deps.distributors = [{ name: "lcsc", lookup: async () => null }]
	let searched = 0
	s.deps.webFind = async () => (searched++, null)
	s.deps.propose = async () => [{ mpn: "BRG-AMP1", datasheetUrl: "https://maker.example/brg-amp1.pdf" }]
	const r = await learnPart(NEED, s.deps)
	assert.equal(r.status, "learned", JSON.stringify(r))
	assert.equal(searched, 0)
	if (r.status === "learned") assert.equal(r.part.documents[0].url, "https://maker.example/brg-amp1.pdf")
})

test("a proposed datasheet that doesn't name the part is not used", async () => {
	const s = setup()
	s.deps.distributors = [{ name: "lcsc", lookup: async () => null }]
	let searched = 0
	s.deps.webFind = async () => (searched++, null)
	s.deps.propose = async () => [{ mpn: "BRG-AMP9", datasheetUrl: "https://maker.example/brg-amp1.pdf" }]
	const r = await learnPart(NEED, s.deps)
	assert.equal(r.status, "unavailable")
	assert.equal(searched, 1, "fell back to the web search")
})

test("the footprint search is told whether the part has a pad underneath", async () => {
	const s = setup({ candidates: ["BRG-AMP1"] })
	const asked: { exposedPad?: boolean }[] = []
	s.deps.footprint = async (p) => (asked.push(p), FOOTPRINT)
	const inner = s.deps.reader
	s.deps.reader = { read: async (req) => {
		const r = await inner.read(req)
		const facts = (r.json as { facts?: { field: string; value: unknown }[] })?.facts
		facts?.forEach((f) => { if (f.field === "pins") f.value = `${f.value}, EP` })
		return r
	} }
	await learnPart(NEED, s.deps)
	// BRG-AMP1's page 2 names no pad, so its EP is not taken.
	assert.equal(asked[0].exposedPad, undefined)
})

test("a board part that can't run from the board's 3.3 V or 5 V is not learned, whatever else checks out", async () => {
	const s = setup({ candidates: ["BRG-AMP1"] })
	const inner = s.deps.reader
	s.deps.reader = { read: async (req) => {
		const r = await inner.read(req)
		;(r.json as { facts?: { field: string; value: unknown }[] })?.facts?.forEach((f) => { if (f.field === "supplyRange") f.value = [2.5, 5.5] })
		return r
	} }
	assert.equal((await learnPart(NEED, s.deps)).status, "learned", "2.5-5.5 V runs from either rail")
	const { fitsBoardSupply } = await import("../src/learn/learner.ts")
	assert.equal(fitsBoardSupply([{ field: "supplyRange", value: [8, 26], status: "datasheet", critical: true }]), "runs from 8–26 V, not from the board's 3.3 V or 5 V")
	assert.equal(fitsBoardSupply([{ field: "supplyRange", value: [4.5, 26], status: "datasheet", critical: true }]), null)
	assert.equal(fitsBoardSupply([]), null, "an unpowered part")
})

test("parts already learned of the need's kind are offered to the proposer, to reuse for free", async () => {
	const s = setup()
	const first = await learnPart(NEED, s.deps)
	assert.equal(first.status, "learned")
	const offered: { mpn: string; summary: string }[][] = []
	s.deps.propose = async (_n, _e, known) => (offered.push(known ?? []), [known?.[0]?.mpn ?? "X"])
	const again = await learnPart({ ...NEED, id: "n2" }, s.deps)
	assert.equal(offered[0][0].mpn, "BRG-AMP1")
	assert.match(offered[0][0].summary, /minLoadOhm 4 Ω/)
	assert.ok(again.status === "learned" && again.reused)
})

test("a learned part of the need's kind that a quick check says fits is reused before anything is proposed", async () => {
	const s = setup()
	assert.equal((await learnPart(NEED, s.deps)).status, "learned")
	let proposed = 0
	const asked: string[] = []
	s.deps.propose = async () => (proposed++, ["X"])
	s.deps.fits = async (_need, part) => (asked.push(part.mpn), { fits: true })
	const again = await learnPart({ ...NEED, id: "n2" }, s.deps)
	assert.ok(again.status === "learned" && again.reused && again.part.mpn === "BRG-AMP1")
	assert.deepEqual(asked, ["BRG-AMP1"])
	assert.equal(proposed, 0)
})

test("a learned part the check says doesn't fit is passed over, and new candidates are proposed", async () => {
	const s = setup()
	await learnPart(NEED, s.deps)
	let proposed = 0
	s.deps.propose = async () => (proposed++, [])
	s.deps.fits = async () => ({ fits: false, why: "too weak" })
	assert.equal((await learnPart({ ...NEED, id: "n2" }, s.deps)).status, "unavailable")
	assert.equal(proposed, 1)
})
