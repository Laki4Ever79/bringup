import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runDesign } from "../src/run.ts"
import { checkConsistency } from "../src/contract/consistency.ts"
import { circuitFromContract, testPoints, TEST_PAD, mountingHoles } from "../src/codegen/circuit.ts"
import { defaultTestSpec, testkitHeader, testPlan, fixtureChecks } from "../src/contract/testkit.ts"
import { DesignContract } from "../src/contract/contract.ts"
import { BUILD_INPUTS, BUILD_REQUIRES } from "../src/agents/builders.ts"
import { BUILDS } from "../src/dashboard/lanes.js"
import { changeRipples } from "../src/runner/ripple.ts"
import { MIC_PART, MIC_PINS } from "../src/inference/scripts.ts"
import { stubBoard } from "../src/tools/stubs.ts"
import { fixtureArtifacts, fixtureContract } from "./fixture.ts"
import { tempDir } from "./helpers.ts"

function withTest() {
	const c = fixtureContract()
	c.values.test = defaultTestSpec(c)
	c.versions.test = 1
	return c
}
const kinds = (c: ReturnType<typeof fixtureContract>) => checkConsistency(c, {}).map((v) => v.kind).filter((k) => k.startsWith("test"))

test("the default test probes every signal, ground, 3V3 and the battery node, with limits over the design's own currents", () => {
	const c = withTest()
	const t = c.values.test!
	for (const p of c.values.pins!) assert.ok(t.points.includes(p.signal), p.signal)
	assert.ok(t.points.includes("GND") && t.points.includes("3V3"))
	assert.deepEqual(kinds(c), [])
})

test("a new pin is a test pad the fixture can't reach: the test agent is woken", () => {
	const c = withTest()
	c.values.pins = [...c.values.pins!, { signal: "BUTTON", gpio: 3, partRef: "U1", partPin: "GPIO3" }]
	const v = checkConsistency(c, {}).find((x) => x.kind === "test-uncovered")!
	assert.deepEqual(v.affects, ["test"])
	assert.match(v.message, /BUTTON/)
})

test("a probe on a net the design dropped, and a limit below the design's own current, wake the test agent", () => {
	const c = withTest()
	c.values.test = { ...c.values.test!, points: [...c.values.test!.points, "GONE"], awakeMaxMa: 1, sleepMaxUa: 0.1 }
	// The fixture logger has no duty cycle, so only the awake limit has a design figure to fall below.
	assert.deepEqual(kinds(c).sort(), ["test-limit", "test-orphan"])
})

test("test pads sit on the 2.54 mm grid, 3 mm in from the edge, clear of the mounting holes, never two in one place", () => {
	const c = withTest()
	const { placed, unplaced } = testPoints(c)
	assert.deepEqual(unplaced, [])
	assert.equal(placed.length, c.values.test!.points.length)
	const { widthMm: W, heightMm: H } = c.values.outline!
	for (const p of placed) {
		assert.ok(Math.abs(Math.round(p.x / TEST_PAD.pitchMm) * TEST_PAD.pitchMm - p.x) < 1e-6, `${p.ref} x on grid`)
		assert.ok(p.xMm >= TEST_PAD.edgeMm - 1e-6 && p.xMm <= W - TEST_PAD.edgeMm + 1e-6 && p.yMm >= TEST_PAD.edgeMm - 1e-6 && p.yMm <= H - TEST_PAD.edgeMm + 1e-6, `${p.ref} inside`)
		for (const h of mountingHoles(c)) assert.ok(Math.max(Math.abs(p.x - h.x), Math.abs(p.y - h.y)) >= 2.75, `${p.ref} clear of ${h.ref}`)
	}
	assert.equal(new Set(placed.map((p) => `${p.x},${p.y}`)).size, placed.length)
})

test("a board too small for its pads says which nets got none", () => {
	const c = withTest()
	c.values.outline = { ...c.values.outline!, widthMm: 14, heightMm: 10 }
	const v = checkConsistency(c, {}).find((x) => x.kind === "test-unplaced")
	assert.ok(v, "test-unplaced")
	assert.deepEqual(v!.affects, ["test"])
})

test("the board source gets one bottom-side pad per probed net, wired by name (3V3 is the generator's V3V3)", () => {
	const src = circuitFromContract(withTest())
	const pads = [...src.matchAll(/<testpoint name="(TP\d+)"[^>]*layer="bottom"/g)].map((m) => m[1])
	assert.equal(pads.length, withTest().values.test!.points.length)
	assert.match(src, /from="\.TP\d+ > \.pin1" to="net\.V3V3"/)
	assert.doesNotMatch(circuitFromContract(fixtureContract()), /<testpoint/, "no test field, no pads: existing boards are unchanged")
})

test("the contract validates the test field", () => {
	const c = new DesignContract()
	const bad = c.propose({ field: "test", value: { points: [], awakeMaxMa: 10, sleepMaxUa: 5 }, by: "test", baseVersion: 0 })
	assert.equal(bad.status, "invalid")
	const ok = c.propose({ field: "test", value: { points: ["GND"], awakeMaxMa: 10, sleepMaxUa: 5 }, by: "test", baseVersion: 0 })
	assert.equal(ok.status, "applied")
})

test("the plan orders power before current before the self-test, and testkit.h selects the self-tests from the parts", () => {
	const c = withTest()
	const ids = testPlan(c).steps.map((s) => s.id)
	assert.ok(ids.indexOf("3v3") < ids.indexOf("awake") && ids.indexOf("awake") < ids.indexOf("i2c-sensor"), ids.join(","))
	const h = testkitHeader(c)
	assert.match(h, /#define TEST_I2C_SDA PIN_I2C_SDA/)
	assert.doesNotMatch(h, /TEST_MIC/)
	c.values.parts = [...c.values.parts!, MIC_PART]
	c.values.pins = [...c.values.pins!, ...MIC_PINS]
	assert.match(testkitHeader(c), /#define TEST_MIC_SD PIN_MIC_SD/)
})

test("the fixture must sit over the pads the board really has, on their nets", () => {
	const c = withTest()
	const board = stubBoard(c, c.revision, tempDir())
	const probes = testPoints(c).placed
	assert.deepEqual(fixtureChecks(c, board, { probes }), [])
	const moved = probes.map((p, i) => (i === 0 ? { ...p, xMm: p.xMm + 2.54 } : p))
	const v = fixtureChecks(c, board, { probes: moved })
	assert.equal(v.length, 1)
	assert.equal(v[0].kind, "fixture-mismatch")
	assert.deepEqual(v[0].affects, [], "the builders rebuild; nobody is woken")
	// The real board's artifact via the shared check: a fixture built for another layout is a violation.
	assert.ok(checkConsistency(c, { ...fixtureArtifacts(), board, testkit: { revision: 1, dir: "", probes: moved, planPath: "", fixtureStlPath: null, fixtureStepPath: null, firmware: { ok: true, log: "", pins: {} }, fixtureIssues: [] } }).some((x) => x.kind === "fixture-mismatch"))
})

test("the dashboard's builds match the builders, test kit included", () => {
	for (const k of Object.keys(BUILD_INPUTS) as (keyof typeof BUILD_INPUTS)[]) {
		assert.deepEqual(BUILDS[k].inputs, BUILD_INPUTS[k], k)
		assert.deepEqual(BUILDS[k].requires, BUILD_REQUIRES[k], k)
	}
})

test("add a production test, then a wake word, then 40 mm: the test follows each change and the design settles", { timeout: 240_000 }, async () => {
	const out = tempDir()
	const brief = readFileSync("briefs/logger.md", "utf8")
	const r = await runDesign({ brief, mock: true, noHardware: true, review: false, outDir: out, changes: ["add a production test fixture", "add a wake word", "make it 40 mm wide"], changeTimeoutMs: 20_000 })
	assert.equal(r.settled, true)
	assert.deepEqual(r.violations, [])
	const contract = JSON.parse(readFileSync(join(out, "contract.json"), "utf8"))
	assert.equal(contract.values.outline.widthMm, 40)
	for (const sig of ["MIC_SCK", "MIC_WS", "MIC_SD"]) assert.ok(contract.values.test.points.includes(sig), `${sig} got a test pad after the wake word`)
	const trace = readFileSync(join(out, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
	assert.ok(trace.some((e) => e.type === "consistency.checked" && e.payload.violations.some((v: { kind: string }) => v.kind === "test-uncovered")), "the mic pins woke the test agent")
	const testChanges = trace.filter((e) => e.type === "contract.changed" && e.payload.field === "test")
	assert.ok(testChanges.length >= 2, "written, then followed the wake word")
	const kits = trace.filter((e) => e.type === "artifact.ready" && e.payload.kind === "testkit")
	assert.ok(kits.length >= 2)
	const ripples = changeRipples(trace)
	assert.ok(ripples[0].woke.includes("test") && ripples[0].woke.includes("build:testkit"), ripples[0].woke.join(","))
	assert.ok(ripples[2].woke.includes("build:testkit"), "the 40 mm change rebuilt the test kit")
	const plan = readFileSync(join(out, "testkit", `rev-${kits.at(-1).payload.revision}`, "test-plan.md"), "utf8")
	assert.match(plan, /microphone.s data line \(MIC_SD\)/)
})

test("without a test field nothing waits for a test kit: the logger settles as before", { timeout: 120_000 }, async () => {
	const out = tempDir()
	const r = await runDesign({ brief: readFileSync("briefs/logger.md", "utf8"), mock: true, noHardware: true, review: false, outDir: out })
	assert.equal(r.settled, true)
	const trace = readFileSync(join(out, "trace.jsonl"), "utf8")
	assert.doesNotMatch(trace, /"kind":"testkit"/)
})
