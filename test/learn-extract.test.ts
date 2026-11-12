import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Budget, BudgetedReader, BudgetExhausted, learnCap } from "../src/learn/budget.ts"
import { createDocStore, type DocStore } from "../src/learn/docs.ts"
import { extractFacts } from "../src/learn/extract.ts"
import { loadKinds } from "../src/learn/kinds.ts"
import type { PageReader, ReadRequest } from "../src/learn/reader.ts"
import type { LearnedDoc } from "../src/learn/types.ts"
import { fixtureFetch } from "./fixtures/learn/fetch.ts"

const kinds = loadKinds(resolve(import.meta.dirname, ".."))
const amp = kinds.get("amplifier")!
const spk = kinds.get("speaker-driver")!

type Answer = { value: unknown; unit?: string; region: [number, number, number, number]; quote?: string }
// Scripted answers by pass, page and field. Returns every scripted field the request asks for.
export function fakeReader(script: Partial<Record<"first" | "second" | "strong", Record<number, Record<string, Answer>>>>, usd: number | null = 0.001) {
	const calls: ReadRequest[] = []
	const reader: PageReader = {
		async read(req) {
			calls.push(req)
			const page = script[req.meta.pass]?.[req.meta.page] ?? {}
			const facts = req.meta.fields.filter((f) => page[f]).map((f) => ({ field: f, ...page[f], quote: page[f].quote ?? String(page[f].value) }))
			return { json: { facts }, usd }
		},
	}
	return { reader, calls }
}

async function docs(): Promise<{ store: DocStore; amp1: LearnedDoc; spk40: LearnedDoc }> {
	const store = createDocStore(mkdtempSync(join(tmpdir(), "extract-")), fixtureFetch().fetch)
	const a = await store.fetch("https://example.com/brg-amp1.pdf", "datasheet")
	const s = await store.fetch("https://example.com/brg-spk40.pdf", "datasheet")
	if ("error" in a || "error" in s) throw new Error("fixtures")
	return { store, amp1: a, spk40: s }
}

const row = (y: number): [number, number, number, number] => [0.4, (y - 12) / 792, 0.4, 20 / 792]

test("a value found in the region's text is marked datasheet, checked by text", async () => {
	const { store, amp1 } = await docs()
	const { reader } = fakeReader({ first: { 1: { supplyRange: { value: [2.5, 5.5], unit: "V", region: row(140) } } } })
	const facts = await extractFacts(amp1, amp, { store, reader })
	const f = facts.find((x) => x.field === "supplyRange")!
	assert.equal(f.status, "datasheet")
	assert.equal(f.check, "text")
	assert.deepEqual(f.source?.page, 1)
	assert.equal(f.source?.doc, amp1.id)
})

test("a value not on the page is dropped when the strong read repeats it", async () => {
	const { store, amp1 } = await docs()
	const wrong = { value: 8, unit: "Ω", region: row(180) }
	const { reader } = fakeReader({ first: { 1: { minLoadOhm: wrong } }, strong: { 1: { minLoadOhm: wrong } } })
	const facts = await extractFacts(amp1, amp, { store, reader })
	assert.equal(facts.find((x) => x.field === "minLoadOhm"), undefined)
})

test("a strong read rescues a wrong cheap read", async () => {
	const { store, amp1 } = await docs()
	const { reader, calls } = fakeReader({ first: { 1: { minLoadOhm: { value: 8, unit: "Ω", region: row(180) } } }, strong: { 1: { minLoadOhm: { value: 4, unit: "Ω", region: row(180) } } } })
	const f = (await extractFacts(amp1, amp, { store, reader })).find((x) => x.field === "minLoadOhm")!
	assert.equal(f.value, 4)
	assert.equal(f.check, "text")
	assert.ok(calls.some((c) => c.meta.pass === "strong" && c.model === "gpt-5.4"))
})

test("pins are confirmed name by name", async () => {
	const { store, amp1 } = await docs()
	const pins = { value: "SD,GAIN,DIN,BCLK,LRCLK,GND,VDD,OUTP,OUTN,GND", region: [0.05, 75 / 792, 0.9, 25 / 792] as [number, number, number, number] }
	const { reader } = fakeReader({ first: { 2: { pins } } })
	const f = (await extractFacts(amp1, amp, { store, reader })).find((x) => x.field === "pins")!
	assert.equal(f.check, "text")
})

const outline = (d: number) => ({ value: [d, 18.5], unit: "mm", region: [0.2, 0.3, 0.5, 0.4] as [number, number, number, number] })

test("an image-only page needs two agreeing reads", async () => {
	const { store, spk40 } = await docs()
	const { reader } = fakeReader({ first: { 2: { outline: outline(40) } }, second: { 2: { outline: outline(40) } } })
	const f = (await extractFacts(spk40, spk, { store, reader })).find((x) => x.field === "outline")!
	assert.equal(f.status, "datasheet")
	assert.equal(f.check, "two-reads")
})

test("on an image-only page the strong read decides a disagreement", async () => {
	const { store, spk40 } = await docs()
	const decided = fakeReader({ first: { 2: { outline: outline(40) } }, second: { 2: { outline: outline(42) } }, strong: { 2: { outline: outline(40) } } })
	assert.deepEqual((await extractFacts(spk40, spk, { store, reader: decided.reader })).find((x) => x.field === "outline")!.value, [40, 18.5])
	const neither = fakeReader({ first: { 2: { outline: outline(40) } }, second: { 2: { outline: outline(42) } }, strong: { 2: { outline: outline(45) } } })
	assert.equal((await extractFacts(spk40, spk, { store, reader: neither.reader })).find((x) => x.field === "outline"), undefined)
})

test("a scanned page never text-matches", async () => {
	const { store, spk40 } = await docs()
	// Everything claimed on page 2 (no text layer), so no fact can be checked by text.
	const { reader } = fakeReader({ first: { 2: { outline: outline(40), impedanceOhm: { value: 8, unit: "Ω", region: [0.1, 0.1, 0.3, 0.1] } } }, second: { 2: { outline: outline(40), impedanceOhm: { value: 8, unit: "Ω", region: [0.1, 0.1, 0.3, 0.1] } } } })
	const facts = await extractFacts(spk40, spk, { store, reader })
	assert.ok(facts.length > 0)
	assert.ok(facts.every((f) => f.check !== "text"))
})

test("the budget refuses a call before it is made", async () => {
	const { store, amp1 } = await docs()
	const { reader, calls } = fakeReader({})
	const budgeted = new BudgetedReader(reader, new Budget(0.0000001))
	await assert.rejects(extractFacts(amp1, amp, { store, reader: budgeted }), BudgetExhausted)
	assert.equal(calls.length, 0)
})

test("a call with an unknown price is charged its estimate", async () => {
	const budget = new Budget(1)
	const { reader } = fakeReader({}, null)
	await new BudgetedReader(reader, budget).read({ model: "gpt-5.4-mini", prompt: "x", images: [Buffer.alloc(1)], maxTokens: 1000, meta: { page: 1, fields: [], pass: "first" } })
	assert.ok(budget.spent > 0)
})

test("the cap comes from the environment, $2 by default", () => {
	assert.equal(learnCap({}), 2)
	assert.equal(learnCap({ BRINGUP_LEARN_CAP_USD: "0.5" }), 0.5)
	assert.equal(learnCap({ BRINGUP_LEARN_CAP_USD: "nope" }), 2)
	assert.equal(learnCap({ BRINGUP_LEARN_CAP_USD: "-1" }), 2)
})
