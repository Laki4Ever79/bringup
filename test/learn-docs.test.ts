import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDocStore } from "../src/learn/docs.ts"
import type { LearnedDoc } from "../src/learn/types.ts"
import { fixtureFetch } from "./fixtures/learn/fetch.ts"

const asDoc = (d: LearnedDoc | { error: string }): LearnedDoc => {
	if ("error" in d) throw new Error(d.error)
	return d
}

test("fetch caches a document by its hash", async () => {
	const root = mkdtempSync(join(tmpdir(), "docs-"))
	const ff = fixtureFetch()
	const store = createDocStore(root, ff.fetch)
	const a = asDoc(await store.fetch("https://example.com/brg-amp1.pdf", "datasheet"))
	assert.equal(a.pages, 2)
	assert.match(a.sha256, /^[0-9a-f]{64}$/)
	assert.ok(store.path(a).startsWith(join(root, ".cache/learn")))
	const b = asDoc(await store.fetch("https://example.com/brg-amp1.pdf", "datasheet"))
	assert.equal(b.sha256, a.sha256)
	assert.equal(ff.calls.length, 1, "the second fetch came from the cache")
})

test("html instead of pdf is rejected", async () => {
	const store = createDocStore(mkdtempSync(join(tmpdir(), "docs-")), fixtureFetch().fetch)
	const r = await store.fetch("https://example.com/landing.html", "datasheet")
	assert.ok("error" in r)
	assert.match(r.error, /not a PDF/)
})

test("a missing document is an error, not a throw", async () => {
	const store = createDocStore(mkdtempSync(join(tmpdir(), "docs-")), fixtureFetch().fetch)
	const r = await store.fetch("https://example.com/nothing.pdf", "datasheet")
	assert.ok("error" in r)
})

test("text in a region of a page", async () => {
	const store = createDocStore(mkdtempSync(join(tmpdir(), "docs-")), fixtureFetch().fetch)
	const d = asDoc(await store.fetch("https://example.com/brg-amp1.pdf", "datasheet"))
	// The supply row sits at y = 140 pt of 792, x from 50 pt.
	const row = await store.textIn(d, 1, [0.05, 125 / 792, 0.6, 25 / 792])
	assert.match(row, /2\.5 ~ 5\.5 V/)
	const elsewhere = await store.textIn(d, 1, [0.05, 600 / 792, 0.6, 50 / 792])
	assert.doesNotMatch(elsewhere, /2\.5/)
	assert.match(await store.textIn(d, 2), /LRCLK/)
})

test("an image-only page has no text", async () => {
	const store = createDocStore(mkdtempSync(join(tmpdir(), "docs-")), fixtureFetch().fetch)
	const d = asDoc(await store.fetch("https://example.com/brg-spk40.pdf", "datasheet"))
	assert.equal(await store.textIn(d, 2), "")
})

test("a page renders to a png", async () => {
	const store = createDocStore(mkdtempSync(join(tmpdir(), "docs-")), fixtureFetch().fetch)
	const d = asDoc(await store.fetch("https://example.com/brg-spk40.pdf", "datasheet"))
	const png = await store.renderPage(d, 2, 50)
	assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
})

test("doctor says whether part learning can read PDFs", async () => {
	const { doctorReport } = await import("../src/setup/doctor.ts")
	const base = { root: "/x", tsci: null, kicad: null, python: null, pio: null }
	assert.match(doctorReport({ ...base, poppler: true }, {}), /poppler \(PDF\)\s+local/)
	assert.match(doctorReport({ ...base, poppler: false }, {}), /part learning needs pdfinfo/)
})
