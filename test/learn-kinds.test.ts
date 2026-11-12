import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { criticalFields, GENERIC_CRITICAL, loadKinds } from "../src/learn/kinds.ts"

const ROOT = resolve(import.meta.dirname, "..")
const kinds = loadKinds(ROOT)
const roles = [...new Set((JSON.parse(readFileSync(join(ROOT, "catalog/parts.json"), "utf8")) as { role: string }[]).map((p) => p.role))]

test("every kind file loads: the two new kinds and one per catalog role", () => {
	for (const k of ["amplifier", "speaker-driver", ...roles]) assert.ok(kinds.has(k), `no kind file for ${k}`)
})

test("a kind can only add critical fields", () => {
	const amp = criticalFields(kinds.get("amplifier")!)
	// An amplifier is soldered (no mount holes) and powered: every other generic field applies.
	for (const f of GENERIC_CRITICAL.filter((f) => f !== "mountHoles")) assert.ok(amp.includes(f), `amplifier lost generic critical ${f}`)
	// The same kind with mount holes gets that one too: a kind file can't drop it by listing less.
	assert.ok(criticalFields({ ...kinds.get("amplifier")!, mountHoles: true, critical: [] }).includes("mountHoles"))
	assert.ok(amp.includes("minLoadOhm"))
})

test("case parts need no footprint, and a speaker driver's impedance and power are critical", () => {
	const spk = criticalFields(kinds.get("speaker-driver")!)
	assert.ok(!spk.includes("footprint"))
	assert.ok(spk.includes("impedanceOhm"))
	assert.ok(spk.includes("ratedPowerW"))
	assert.ok(spk.includes("mountHoles"))
})

test("parts without mount holes or a supply don't need those facts", () => {
	const r = criticalFields(kinds.get("resistor")!)
	assert.ok(!r.includes("mountHoles"))
	assert.ok(!r.includes("supplyMaxV"))
	assert.ok(r.includes("footprint") && r.includes("outline"))
})

test("a default on a critical field is refused, naming the file", () => {
	const root = mkdtempSync(join(tmpdir(), "kinds-"))
	mkdirSync(join(root, "catalog/kinds"), { recursive: true })
	writeFileSync(
		join(root, "catalog/kinds/bad.json"),
		JSON.stringify({ kind: "bad", placement: "board", mountHoles: false, powered: true, fields: [], critical: [], defaults: { pins: { value: "1", reason: "x" } }, calculated: {} }),
	)
	assert.throws(() => loadKinds(root), /bad\.json/)
})
