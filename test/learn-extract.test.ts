import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Budget, BudgetedReader, BudgetExhausted, learnCap } from "../src/learn/budget.ts"
import { createDocStore, type DocStore } from "../src/learn/docs.ts"
import { extractFacts, identifyPart, pagesToRead } from "../src/learn/extract.ts"
import { loadKinds } from "../src/learn/kinds.ts"
import type { LearnedDoc } from "../src/learn/types.ts"
import { fixtureFetch } from "./fixtures/learn/fetch.ts"
import { fakeReader } from "./fixtures/learn/reader.ts"

const kinds = loadKinds(resolve(import.meta.dirname, ".."))
const amp = kinds.get("amplifier")!
const spk = kinds.get("speaker-driver")!

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

const PAIRS = "1 SD, 2 GAIN, 3 DIN, 4 BCLK, 5 LRCLK, 6 GND, 7 VDD, 8 OUTP, 9 OUTN, 10 GND"

test("pins are read as number-name pairs, confirmed pair by pair, and kept as names in pin-number order", async () => {
	const { store, amp1 } = await docs()
	const pins = { value: PAIRS, region: [0.05, 75 / 792, 0.9, 25 / 792] as [number, number, number, number] }
	const { reader, calls } = fakeReader({ first: { 2: { pins } } })
	const f = (await extractFacts(amp1, amp, { store, reader })).find((x) => x.field === "pins")!
	assert.equal(f.check, "text")
	assert.equal(f.value, "SD,GAIN,DIN,BCLK,LRCLK,GND,VDD,OUTP,OUTN,GND")
	assert.ok(calls.every((c) => c.meta.pass === "first"))
	assert.match(calls[0].prompt, /pins: .*number/i)
})

test("terminals with names but no numbers (a speaker's + and -) are checked as one printed sequence", async () => {
	const { store, spk40 } = await docs()
	const terminals = { value: "+,-", region: [0.05, 206 / 792, 0.9, 24 / 792] as [number, number, number, number] }
	const { reader } = fakeReader({ first: { 1: { pins: terminals } } })
	const f = (await extractFacts(spk40, spk, { store, reader })).find((x) => x.field === "pins")!
	assert.equal(f.check, "text")
	assert.equal(f.value, "+,-")
	const swapped = fakeReader({ first: { 1: { pins: { ...terminals, value: "-,+" } } }, strong: { 1: { pins: { ...terminals, value: "-,+" } } } })
	assert.equal((await extractFacts(spk40, spk, { store, reader: swapped.reader })).find((x) => x.field === "pins"), undefined)
})

test("a value claimed a line away from where it's printed is confirmed by its own words, without the strong model", async () => {
	const { store, amp1 } = await docs()
	const { reader, calls } = fakeReader({ first: { 1: { supplyMaxV: { value: 6, unit: "V", region: row(178) } } } })
	const stats = { firstRead: 0 }
	const f = (await extractFacts(amp1, amp, { store, reader, stats })).find((x) => x.field === "supplyMaxV")!
	assert.equal(f.check, "text")
	assert.ok(calls.every((c) => c.meta.pass === "first"), "no strong read")
	assert.ok(f.source!.region[1] < 160 / 792 && f.source!.region[1] + f.source!.region[3] > 150 / 792, "the region is the printed value's own box")
	assert.match(f.source!.quote, /Absolute maximum VDD 6\.0 V/)
	assert.equal(stats.firstRead, 1)
})

test("the prompt names the part, so a datasheet covering several packages is read for this one", async () => {
	const { store, amp1 } = await docs()
	const { reader, calls } = fakeReader({})
	await extractFacts(amp1, amp, { store, reader, mpn: "BRG-AMP1QFN" })
	assert.match(calls[0].prompt, /BRG-AMP1QFN/)
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

test("the footprint is never read from the datasheet; the package name is only a hint", async () => {
	const { store, amp1 } = await docs()
	const { reader, calls } = fakeReader({ first: { 2: { footprint: { value: "QFN-10", region: [0.05, 115 / 792, 0.9, 24 / 792] }, package: { value: "QFN-10", region: [0.05, 115 / 792, 0.9, 24 / 792] } } } })
	const facts = await extractFacts(amp1, amp, { store, reader })
	assert.ok(calls.every((c) => !c.meta.fields.includes("footprint")))
	assert.equal(facts.find((f) => f.field === "footprint"), undefined)
	assert.equal(facts.find((f) => f.field === "package")?.value, "QFN-10")
})

test("a region too big to point at one value doesn't pass the text check", async () => {
	const { store, amp1 } = await docs()
	// supplyMaxV claimed as 5.5 V (the recommended maximum, not the absolute one) with the whole table as its region.
	const loose = { value: 5.5, unit: "V", region: [0, 0, 1, 0.5] as [number, number, number, number] }
	const { reader } = fakeReader({ first: { 1: { supplyMaxV: loose } }, strong: { 1: { supplyMaxV: loose } } })
	assert.equal((await extractFacts(amp1, amp, { store, reader })).find((f) => f.field === "supplyMaxV"), undefined)
})

test("the quote shown is the page's own text, not the model's", async () => {
	const { store, amp1 } = await docs()
	const { reader } = fakeReader({ first: { 1: { supplyRange: { value: [2.5, 5.5], unit: "V", region: row(140), quote: "invented" } } } })
	const f = (await extractFacts(amp1, amp, { store, reader })).find((x) => x.field === "supplyRange")!
	assert.match(f.source!.quote, /2\.5 ~ 5\.5 V/)
})

test("a drawing region with no text on a page that has text takes the two-read path", async () => {
	const { store, amp1 } = await docs()
	// Page 2 has text, but the line at y = 200 pt has none around it, and 4 x 4 mm is printed nowhere: a drawing.
	const drawn = { value: [4, 4], unit: "mm", region: [0.3, 190 / 792, 0.2, 20 / 792] as [number, number, number, number] }
	const { reader } = fakeReader({ first: { 2: { outline: drawn } }, second: { 2: { outline: drawn } } })
	const f = (await extractFacts(amp1, amp, { store, reader })).find((x) => x.field === "outline")!
	assert.equal(f?.check, "two-reads")
})

test("concurrent calls can't together cross the cap: each reserves its worst case first", async () => {
	// One worst-case page read is about $0.0086 on gpt-5.4-mini: one fits under $0.012, two don't.
	const budget = new Budget(0.012)
	let release!: () => void
	const gate = new Promise<void>((r) => (release = r))
	const slow = { read: async () => (await gate, { json: {}, usd: 0.001 }) }
	const r = new BudgetedReader(slow, budget)
	const req = { model: "gpt-5.4-mini", prompt: "x", images: [Buffer.alloc(1)], maxTokens: 1500, meta: { page: 1, fields: [], pass: "first" as const } }
	const first = r.read(req)
	await assert.rejects(r.read(req), BudgetExhausted, "the second call doesn't fit next to the first one's reservation")
	release()
	await first
	assert.ok(Math.abs(budget.spent - 0.001) < 1e-9, "the reservation is replaced by the real cost")
})

test("long datasheets: contents and revision pages are skipped, at most 8 pages read", async () => {
	const texts: Record<number, string> = { 1: "TPA1 amplifier features", 2: "Table of Contents\n1 Features ........ 1\n2 Pin Configuration ........ 3\n3 Absolute Maximum Ratings ........ 4\n4 Electrical Characteristics ........ 5\n5 Layout ........ 9", 3: "Pin Configuration and Functions", 4: "Absolute Maximum Ratings", 5: "Electrical Characteristics", 6: "Typical Characteristics graphs" }
	for (let p = 7; p <= 30; p++) texts[p] = p % 3 === 0 ? "Recommended Operating Conditions" : p === 28 ? "Mechanical data, package outline" : "application notes"
	const store = { textIn: async (_d: unknown, p: number) => texts[p] ?? "" } as unknown as DocStore
	const pages = await pagesToRead({ id: "d", url: "", sha256: "", pages: 30, fetchedAt: "", kind: "datasheet" }, store)
	assert.ok(!pages.includes(2), "the contents page")
	assert.ok(pages.includes(1) && pages.includes(3) && pages.includes(4) && pages.includes(5))
	assert.ok(pages.includes(28), "the package drawing near the end")
	assert.ok(pages.length <= 8, String(pages))
})

test("a datasheet for a different kind of part is caught from its first page", async () => {
	const { store, amp1 } = await docs()
	const asked: string[] = []
	const reader = { read: async (req: { prompt: string; meta: { pass: string } }) => (asked.push(req.prompt), { json: { matches: false, part: "a class-D audio amplifier IC" }, usd: 0.0005 }) }
	const r = await identifyPart(amp1, spk, "TPA2005D1", { store, reader })
	assert.deepEqual(r, { matches: false, part: "a class-D audio amplifier IC" })
	assert.match(asked[0], /loudspeaker/)
	// No answer (a reader that doesn't know the question) is never a rejection.
	assert.equal((await identifyPart(amp1, spk, "X", { store, reader: fakeReader({}).reader })).matches, true)
})

test("the package drawing read is the one for this part's package, and pages that only mention sections aren't read", async () => {
	const texts: Record<number, string> = { 1: "TPA9 amplifier", 2: "", 3: "6 Pin Configuration and Functions", 4: "7.1 Absolute Maximum Ratings\n7.3 Recommended Operating Conditions", 5: "7.5 Electrical Characteristics" }
	for (let p = 6; p <= 40; p++) texts[p] = "see the Specifications and the Mechanical, Packaging and Orderable Information"
	texts[36] = "PACKAGE OUTLINE DRB0008A VSON - 1 mm max height"
	texts[40] = "PACKAGE OUTLINE DGN0008G PowerPAD VSSOP - 1.1 mm max height"
	const store = { textIn: async (_d: unknown, p: number) => texts[p] ?? "" } as unknown as DocStore
	const doc = { id: "d", url: "", sha256: "", pages: 40, fetchedAt: "", kind: "datasheet" as const }
	assert.deepEqual(await pagesToRead(doc, store, "TPA9D1DGN"), [1, 2, 3, 4, 5, 40])
	assert.deepEqual(await pagesToRead(doc, store, "TPA9D1DRBR"), [1, 2, 3, 4, 5, 36])
	assert.deepEqual(await pagesToRead(doc, store), [1, 2, 3, 4, 5, 36], "no part number: the first drawing")
})

test("every claim the model makes is traced with how it was checked", async () => {
	const { store, amp1 } = await docs()
	const traced: { field: string; pass: string; outcome: string }[] = []
	const { reader } = fakeReader({ first: { 1: { supplyMaxV: { value: 6, unit: "V", region: row(160) }, minLoadOhm: { value: 8, unit: "Ω", region: row(180) } } } })
	await extractFacts(amp1, amp, { store, reader, onClaim: (c) => traced.push(c) })
	assert.ok(traced.some((t) => t.field === "supplyMaxV" && t.pass === "first" && t.outcome === "text"))
	assert.ok(traced.some((t) => t.field === "minLoadOhm" && t.pass === "first" && t.outcome === "not found near its region"))
})

test("a specifications heading doesn't stand in for the electrical characteristics on the next page", async () => {
	const texts: Record<number, string> = { 1: "x", 3: "Pin Configuration", 4: "7 Specifications\n7.1 Absolute Maximum Ratings", 5: "7.5 Electrical Characteristics" }
	const store = { textIn: async (_d: unknown, p: number) => texts[p] ?? "filler" } as unknown as DocStore
	assert.deepEqual(await pagesToRead({ id: "d", url: "", sha256: "", pages: 20, fetchedAt: "", kind: "datasheet" }, store), [1, 3, 4, 5])
})

test("a value printed elsewhere on a text page goes to the strong model, never to two agreeing reads", async () => {
	const { store, amp1 } = await docs()
	// 6.0 V is printed on page 1, but the model's box is in empty space at the bottom of the page.
	const off = { value: 6, unit: "V", region: [0.4, 0.9, 0.1, 0.02] as [number, number, number, number] }
	const { reader, calls } = fakeReader({ first: { 1: { supplyMaxV: off } }, second: { 1: { supplyMaxV: off } }, strong: { 1: { supplyMaxV: off } } })
	assert.equal((await extractFacts(amp1, amp, { store, reader })).find((f) => f.field === "supplyMaxV"), undefined)
	assert.ok(!calls.some((c) => c.meta.pass === "second"))
})

test("the model's printed label confirms a value its box misplaced", async () => {
	const { store, amp1 } = await docs()
	const { reader } = fakeReader({ first: { 1: { supplyMaxV: { value: 6, unit: "V", label: "Absolute maximum VDD", region: [0.4, 0.9, 0.1, 0.02] } } } })
	const f = (await extractFacts(amp1, amp, { store, reader })).find((x) => x.field === "supplyMaxV")
	assert.equal(f?.check, "text")
	assert.match(f!.source!.quote, /Absolute maximum VDD 6\.0 V/)
})

// A fake datasheet: page texts and words (one row per line, words 4 pt per character apart), 10 pages so the page
// choice applies.
function fakeDoc(pages: Record<number, string[]>) {
	const wordsOf = (p: number) =>
		(pages[p] ?? []).flatMap((line, i) => {
			let x = 50
			return line.split(" ").map((text) => {
				const w = { text, region: [x / 612, (100 + i * 20) / 792, (text.length * 4) / 612, 9 / 792] as [number, number, number, number] }
				x += text.length * 4 + 4
				return w
			})
		})
	const store = {
		textIn: async (_d: unknown, p: number) => (pages[p] ?? []).join("\n"),
		words: async (_d: unknown, p: number) => wordsOf(p),
		renderPage: async () => Buffer.alloc(1),
	} as unknown as DocStore
	return { store, doc: { id: "d", url: "", sha256: "", pages: 10, fetchedAt: "", kind: "datasheet" as const } }
}
const at = (line: number): [number, number, number, number] => [0.05, (95 + line * 20) / 792, 0.5, 20 / 792]

test("outline and package come first from the drawing for this part's package, not page 1's list of versions", async () => {
	const { store, doc } = fakeDoc({ 1: ["Device Information", "DSBGA (16) 2.01 mm x 2.01 mm", "WQFN (20) 4.00 mm x 4.00 mm"], 10: ["PACKAGE OUTLINE RTJ0020D WQFN", "4.00 x 4.00 body"] })
	const { reader } = fakeReader({
		first: {
			1: { outline: { value: [2.01, 2.01], unit: "mm", label: "DSBGA (16)", region: at(1) }, package: { value: "DSBGA (16)", region: at(1) } },
			10: { outline: { value: [4, 4], unit: "mm", label: "body", region: at(1) }, package: { value: "WQFN", region: at(0) } },
		},
	})
	const facts = await extractFacts(doc, amp, { store, reader, mpn: "TPA2012D2RTJT" })
	assert.deepEqual(facts.find((f) => f.field === "outline")?.value, [4, 4])
	assert.equal(facts.find((f) => f.field === "package")?.value, "WQFN")
})

test("a dimension a drawing's text layer doesn't hold is confirmed by two reads; a table value isn't", async () => {
	// The drawing page's text is garbled (an unreadable drawing font): 0.8 is printed nowhere in it.
	const { store, doc } = fakeDoc({ 1: ["Supply voltage 2.5 5.5 V"], 10: ["PACKAGE OUTLINE RTJ0020D", "#$% &*( )@!"] })
	const h = { value: 0.8, unit: "mm", region: at(1) }
	const vmax = { value: 6, unit: "V", region: at(0) }
	const { reader } = fakeReader({ first: { 10: { height: h }, 1: { supplyMaxV: vmax } }, second: { 10: { height: h }, 1: { supplyMaxV: vmax } }, strong: { 1: { supplyMaxV: vmax } } })
	const facts = await extractFacts(doc, amp, { store, reader, mpn: "TPA2012D2RTJT" })
	assert.equal(facts.find((f) => f.field === "height")?.check, "two-reads")
	assert.equal(facts.find((f) => f.field === "supplyMaxV"), undefined)
})

test("a pin-out read again gets the tokens a long pin list needs", async () => {
	const { store, amp1 } = await docs()
	const wrong = { value: "1 SD, 2 MUTE", region: [0.05, 75 / 792, 0.9, 25 / 792] as [number, number, number, number] }
	const { reader, calls } = fakeReader({ first: { 2: { pins: wrong } } })
	await extractFacts(amp1, amp, { store, reader })
	const again = calls.find((c) => c.meta.pass === "strong" && c.meta.fields.includes("pins"))!
	assert.ok(again.maxTokens >= 1500)
})

test("the prompt asks for the words printed next to a drawing's dimension as its label", async () => {
	const { store, amp1 } = await docs()
	const { reader, calls } = fakeReader({})
	await extractFacts(amp1, amp, { store, reader })
	assert.match(calls[0].prompt, /dimension.*"MAX"|"MAX".*dimension/)
})

test("a package whose heat pad faces up has no pad to solder: the exposed-pad fact says no, with its caption as the source", async () => {
	const { store, doc } = fakeDoc({ 3: ["Pin Configuration and Functions", "DAP Package", "32-Pin HTSSOP With PowerPAD Down", "DAD Package", "32-Pin HTSSOP With PowerPAD Up", "MODSEL 1 32 PVCC", "SDZ 2 31 PVCC"] })
	const { reader } = fakeReader({ first: { 3: { pins: { value: "1 MODSEL, 2 SDZ", region: at(5) } } } })
	const facts = await extractFacts(doc, amp, { store, reader, mpn: "TPA3126D2DADR" })
	const ep = facts.find((f) => f.field === "exposedPad")
	assert.equal(ep?.value, "no")
	assert.match(ep!.source!.quote, /PowerPAD Up/)
	assert.equal(facts.find((f) => f.field === "pins")?.value, "MODSEL,SDZ")
})

test("a pin-out ending in EP says the part has a pad underneath, once the page names one; EP is not a pin", async () => {
	const { store, doc } = fakeDoc({ 3: ["Pin Functions", "SD 1 I Shutdown", "GAIN 2 I Gain", "Thermal Pad Must be soldered to a grounded pad"] })
	const { reader } = fakeReader({ first: { 3: { pins: { value: "1 SD, 2 GAIN, EP", region: at(0) } } } })
	const facts = await extractFacts(doc, amp, { store, reader })
	assert.equal(facts.find((f) => f.field === "pins")?.value, "SD,GAIN")
	assert.equal(facts.find((f) => f.field === "exposedPad")?.value, "yes")
	const bare = fakeDoc({ 3: ["Pin Functions", "SD 1 I Shutdown", "GAIN 2 I Gain"] })
	const r2 = fakeReader({ first: { 3: { pins: { value: "1 SD, 2 GAIN, EP", region: at(0) } } } })
	assert.equal((await extractFacts(bare.doc, amp, { store: bare.store, reader: r2.reader })).find((f) => f.field === "exposedPad"), undefined, "no pad named on the page")
})
