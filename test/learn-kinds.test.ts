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
	assert.ok(amp.includes("minLoadOhm"))
})

test("case parts need no footprint, and a speaker driver's impedance and power are critical, its outline (what the case clamps) but not mount holes", () => {
	const spk = criticalFields(kinds.get("speaker-driver")!)
	assert.ok(!spk.includes("footprint"))
	assert.ok(spk.includes("impedanceOhm"))
	assert.ok(spk.includes("ratedPowerW"))
	assert.ok(!spk.includes("mountHoles"), "the case clamps a speaker by its rim")
	assert.ok(spk.includes("outline"))
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
		JSON.stringify({ kind: "bad", placement: "board", fields: [], critical: [], defaults: { pins: { value: "1", reason: "x" } }, calculated: {} }),
	)
	assert.throws(() => loadKinds(root), /bad\.json/)
})

test("a new kind file can't drop mount holes or supply limits, whatever it says", () => {
	const root = mkdtempSync(join(tmpdir(), "kinds-"))
	mkdirSync(join(root, "catalog/kinds"), { recursive: true })
	writeFileSync(join(root, "catalog/kinds/display.json"), JSON.stringify({ kind: "display", placement: "case", mountHoles: false, powered: false, fields: [], critical: [], defaults: {}, calculated: {} }))
	const c = criticalFields(loadKinds(root).get("display")!)
	for (const f of ["outline", "height", "mountHoles", "pins", "supplyMaxV", "supplyRange"]) assert.ok(c.includes(f), `display lost ${f}`)
})

test("every critical field is asked for, even one the kind file doesn't list", async () => {
	const { fieldsToRead } = await import("../src/learn/kinds.ts")
	const display = { kind: "display", placement: "case" as const, fields: [], critical: [], defaults: {}, calculated: {} }
	const asked = fieldsToRead(display).map((f) => f.field)
	for (const f of ["outline", "height", "mountHoles", "pins", "supplyMaxV", "supplyRange"]) assert.ok(asked.includes(f), `${f} is not asked for`)
	assert.ok(!asked.includes("footprint"))
	assert.ok(fieldsToRead(display).every((f) => f.what.length > 0))
})
