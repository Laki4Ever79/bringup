import { test } from "node:test"
import assert from "node:assert/strict"
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { learnedFileName, readLearned, toCatalogPart, writeLearned } from "../src/learn/catalog.ts"
import type { LearnedPart } from "../src/learn/types.ts"
import { loadCatalog } from "../src/tools/parts-search.ts"

const ROOT = resolve(import.meta.dirname, "..")

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "learned-"))
	mkdirSync(join(root, "catalog"), { recursive: true })
	copyFileSync(join(ROOT, "catalog/parts.json"), join(root, "catalog/parts.json"))
	return root
}

export const AMP: LearnedPart = {
	mpn: "BRG-AMP1",
	role: "amplifier",
	kind: "amplifier",
	placement: "board",
	facts: [
		{ field: "pins", value: "SD,GAIN,DIN,BCLK,LRCLK,GND,VDD,OUTP,OUTN,GND", status: "datasheet", critical: true, check: "text", source: { doc: "d1", page: 2, region: [0.1, 0.2, 0.5, 0.3], quote: "SD GAIN DIN" } },
		{ field: "footprint", value: "kicad:Package_DFN_QFN:QFN-10", status: "datasheet", critical: true, check: "text" },
	],
	documents: [{ id: "d1", url: "https://example.com/brg-amp1.pdf", sha256: "ab".repeat(32), pages: 2, fetchedAt: "2026-11-12T10:00:00Z", kind: "datasheet" }],
	orderFrom: [{ distributor: "lcsc", mpn: "BRG-AMP1", sku: "C999001", stock: 100, priceUsd: 0.5, assemblerStocked: true }],
	learnedAt: "2026-11-12T10:00:00Z",
	learner: ["gpt-5.4-mini"],
	costUsd: 0.04,
}

test("unsafe mpn file name", () => {
	assert.match(learnedFileName("MAX98357A/ETE+T"), /^max98357a_ete_t-[0-9a-f]{8}\.json$/)
	assert.notEqual(learnedFileName("A/B"), learnedFileName("A_B"))
	assert.ok(!learnedFileName("../../etc").includes("/"))
})

test("a learned part round-trips through its file", () => {
	const root = tempRoot()
	writeLearned(root, AMP)
	assert.deepEqual(readLearned(root), [AMP])
})

test("loadCatalog includes learned parts, as catalog parts", () => {
	const root = tempRoot()
	writeLearned(root, AMP)
	const p = loadCatalog(root).find((c) => c.mpn === "BRG-AMP1")
	assert.ok(p)
	assert.equal(p.role, "amplifier")
	assert.equal(p.lcsc, "C999001")
	assert.equal(p.footprint, "kicad:Package_DFN_QFN:QFN-10")
	assert.deepEqual(p.pins.slice(0, 3), ["SD", "GAIN", "DIN"])
	assert.deepEqual(toCatalogPart(AMP).pins.length, 10)
})

test("a hand entry wins over a learned part with the same mpn", () => {
	const root = tempRoot()
	writeLearned(root, { ...AMP, mpn: "SHT40-AD1B-R2", role: "sensor" })
	const hits = loadCatalog(root).filter((c) => c.mpn === "SHT40-AD1B-R2")
	assert.equal(hits.length, 1)
	assert.equal(hits[0].role, "sensor")
	assert.equal(hits[0].footprint, "dfn4")
})

test("a bad learned file is skipped", () => {
	const root = tempRoot()
	writeLearned(root, AMP)
	writeFileSync(join(root, "catalog/learned/broken.json"), "{not json")
	assert.deepEqual(readLearned(root).map((p) => p.mpn), ["BRG-AMP1"])
})
