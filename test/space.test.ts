import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runDesign } from "../src/run.ts"
import { checkConsistency } from "../src/contract/consistency.ts"
import { DesignContract } from "../src/contract/contract.ts"
import { minimumBoard, placesAll, SIZE_REASONS, SLACK_LIMIT, spaceChecks, spaceFactLines } from "../src/contract/space.ts"
import { minCaseHeight } from "../src/contract/case.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { fixtureContract } from "./fixture.ts"
import { tempDir } from "./helpers.ts"

// The scripted logger, without the brief's size as its reason: what the rules judge on their own.
const logger = () => {
	const s = fixtureContract()
	const { sizeReason: _r, ...outline } = structuredClone(LOGGER_DESIGN.outline)
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN), outline }
	return s
}

test("the logger's smallest board, by placement: every part fits on 30×27 mm, under the 70% density ceiling", () => {
	const min = minimumBoard(logger())!
	// The module's antenna hangs past the edge, so only its pad area takes board space.
	assert.deepEqual([min.widthMm, min.heightMm, min.areaMm2, min.limitedBy], [30, 27, 810, "placement"])
	assert.ok(min.courtyardMm2 / min.areaMm2 < 0.7, `${min.courtyardMm2} mm² of courtyards`)
	assert.ok(placesAll(logger(), 30, 27))
	assert.ok(!placesAll(logger(), 29, 27))
})

test("a board over the limit with no reason wakes the architect; a recorded reason, or a compact board, doesn't", () => {
	const s = logger()
	assert.equal(s.values.outline!.sizeReason, undefined)
	const v = spaceChecks(s)
	assert.deepEqual(v.map((x) => [x.kind, x.affects[0]]), [["space-slack", "architect"]])
	assert.match(v[0].message, /50×30 mm \(1500 mm²\), 85% over the smallest it can be \(810 mm²/)
	s.values.outline = { ...s.values.outline!, sizeReason: { kind: "engineer-size", detail: "the brief asks for about 50 × 30 mm" } }
	assert.deepEqual(spaceChecks(s), [])
	const compact = logger()
	compact.values.outline = { ...compact.values.outline!, widthMm: 33, heightMm: 28 }
	// 924 mm² is 14% over 810: within the limit.
	assert.ok(924 / 810 - 1 <= SLACK_LIMIT)
	assert.deepEqual(spaceChecks(compact), [])
})

test("the case body follows the same rule: its contents' height plus 15%, or a reason", () => {
	const s = fixtureContract()
	s.values.case = { wallMm: 2, heightMm: 20, features: [] }
	assert.equal(minCaseHeight(s), 13.6)
	assert.deepEqual(spaceChecks(s).map((x) => [x.kind, x.affects[0]]), [["space-slack", "enclosure"]])
	s.values.case = { ...s.values.case, sizeReason: { kind: "usability", detail: "room for a coin cell holder later" } }
	assert.deepEqual(spaceChecks(s), [])
	// A wall hole needs its wall: a 12.2 mm gland raises what the contents need, so 19 mm is no longer slack.
	s.values.case = { wallMm: 2, heightMm: 19, features: [{ id: "g", kind: "hole", edge: "right", offsetMm: 15, diameterMm: 12.2 }] }
	assert.equal(minCaseHeight(s), 18.2)
	assert.deepEqual(spaceChecks(s), [])
})

test("the contract takes only a listed reason, with what it is in this design", () => {
	const c = new DesignContract()
	const o = { widthMm: 50, heightMm: 30, thicknessMm: 1.6 }
	for (const kind of Object.keys(SIZE_REASONS)) assert.equal(c.validate({ field: "outline", value: { ...o, sizeReason: { kind, detail: "x" } } as never, by: "architect" }), null, kind)
	assert.ok(c.validate({ field: "outline", value: { ...o, sizeReason: { kind: "looks nice", detail: "x" } } as never, by: "architect" }))
	assert.ok(c.validate({ field: "outline", value: { ...o, sizeReason: { kind: "usability", detail: " " } } as never, by: "architect" }))
	assert.ok(c.validate({ field: "case", value: { wallMm: 2, heightMm: 14, features: [], sizeReason: { kind: "bigger" } } as never, by: "enclosure" }))
})

test("the design facts give every designer the minimum, the slack, the limit, the reasons and the priority order", () => {
	const s = logger()
	s.values.outline = { ...s.values.outline!, sizeReason: { kind: "engineer-size", detail: "the brief asks for about 50 × 30 mm" } }
	const lines = spaceFactLines(s).join("\n")
	assert.match(lines, /the smallest it can be is 810 mm²/)
	assert.match(lines, /slack 85%, limit 15%, over it for a recorded reason: engineer-size/)
	assert.match(lines, /Priority when rules conflict: safety and manufacturability, the engineer's own words, function, usability, compactness, cost/)
	for (const k of Object.keys(SIZE_REASONS)) assert.ok(lines.includes(k), k)
})

test("the scripted architect records the brief's size as the reason; the run settles with no space violation", { timeout: 120_000 }, async () => {
	const out = tempDir()
	const r = await runDesign({ brief: readFileSync("briefs/logger.md", "utf8"), mock: true, noHardware: true, review: false, outDir: out })
	assert.equal(r.settled, true)
	assert.deepEqual(r.violations, [])
	const contract = JSON.parse(readFileSync(join(out, "contract.json"), "utf8"))
	assert.deepEqual(contract.values.outline.sizeReason, { kind: "engineer-size", detail: "the brief asks for about 50 × 30 mm" })
	assert.match(readFileSync(join(out, "report.md"), "utf8"), /Space: board 50×30 mm is 85% over the smallest it can be .*kept for a reason: engineer-size/)
})

test("a brief that sets no size gets a compact board: the architect shrinks it to the minimum", { timeout: 120_000 }, async () => {
	const out = tempDir()
	const brief = readFileSync("briefs/logger.md", "utf8").replace(/^.*\d+\s*×\s*\d+\s*mm.*$/m, "")
	assert.ok(!/\d+\s*[×x]\s*\d+\s*mm/.test(brief), "the size line is gone")
	const r = await runDesign({ brief, mock: true, noHardware: true, review: false, outDir: out })
	assert.equal(r.settled, true)
	assert.deepEqual(r.violations, [])
	const contract = JSON.parse(readFileSync(join(out, "contract.json"), "utf8"))
	const { widthMm: w, heightMm: h, sizeReason } = contract.values.outline
	assert.equal(sizeReason, undefined)
	// Within the limit of the smallest board, and of those shapes the one nearest the original proportions, not a strip.
	const min = minimumBoard(contract)!
	assert.ok(w * h <= min.areaMm2 * (1 + SLACK_LIMIT), `${w}×${h}`)
	assert.ok(w / h >= 1 && w / h < 2.2, `${w}×${h}`)
	assert.ok(placesAll(contract, w, h))
	// The connector moved with the edge it is on: J1 keeps its place halfway up the left edge.
	assert.equal(contract.values.connectors[0].offsetMm, h / 2)
	const trace = readFileSync(join(out, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
	assert.ok(trace.some((e) => e.type === "consistency.checked" && e.payload.violations.some((v: { kind: string }) => v.kind === "space-slack")))
	assert.deepEqual(checkConsistency(contract, {}).filter((v) => v.kind === "space-slack"), [])
})

test("a half-written design is not judged: the minimum needs the connectors, rails and pins", () => {
	const s = logger()
	delete s.values.pins
	assert.deepEqual(spaceChecks(s), [])
})

test("a board the router can't finish reaches the architect with the router's words, and is answered like a failed DRC", async () => {
	const { buildErrors } = await import("../src/tools/board.ts")
	const log = "Building board.circuit.tsx...\nU1 has no pin with requires_ground=true\nPort pin1 on J1 is missing a trace\nPort pin2 on J1 is missing a trace\nCircuits  0 passed 1 failed"
	assert.match(buildErrors(log), /Port pin1 on J1 is missing a trace/)
})

test("the router's give-up lines don't hide a more specific cause", async () => {
	const { buildErrors } = await import("../src/tools/board.ts")
	const log = "Port pin1 on J1 is missing a trace\nVia hole at (-21.24mm, 2.40mm) overlaps SMD pad J1.pin6\nCircuits  0 passed 1 failed"
	assert.equal(buildErrors(log), "Via hole at (-21.24mm, 2.40mm) overlaps SMD pad J1.pin6\nCircuits  0 passed 1 failed")
})

test("a board that fails KiCad's DRC wakes the architect, but only the board built at the size the contract has now", async () => {
	const { fixtureArtifacts } = await import("./fixture.ts")
	const c = fixtureContract()
	const a = fixtureArtifacts()
	const drc = { rules: "JLCPCB 2-layer", errors: 2, warnings: 0, unconnected: 0, byType: { hole_clearance: 2 }, firstError: "Hole clearance violation (actual 0.1412 mm)" }
	a.board = { ...a.board!, drc }
	const v = checkConsistency(c, a).filter((x) => x.kind === "drc-errors")
	assert.deepEqual(v.map((x) => x.affects), [["architect"]])
	assert.match(v[0].message, /the 50×30 mm board \(rev 6\) fails JLCPCB 2-layer: 2 error\(s\), 0 unconnected; first: Hole clearance violation/)
	// The contract moved on (the architect widened it): the old board is a rebuild under way, not a new failure.
	c.values.outline = { ...c.values.outline!, widthMm: 52 }
	assert.deepEqual(checkConsistency(c, a).filter((x) => x.kind === "drc-errors"), [])
	// Clean, or a stub (no DRC): nothing.
	assert.deepEqual(checkConsistency(fixtureContract(), fixtureArtifacts()).filter((x) => x.kind === "drc-errors"), [])
})

test("the scripted architect answers a failed DRC by widening the board 2 mm, with the failed build as its reason", async () => {
	const { mockScripts } = await import("../src/inference/scripts.ts")
	const { UserMessageItem } = await import("@mozaik-ai/core")
	const { startRuntime, state } = await import("../src/runtime.ts")
	const { BringupState } = await import("../src/runtime.ts")
	const { inferenceConfig } = await import("../src/inference/models.ts")
	const st = new BringupState(tempDir(), 1000)
	startRuntime(st, inferenceConfig(true, {}), join(tempDir(), "trace.jsonl"))
	const c = fixtureContract()
	for (const f of ["requirements", "outline", "connectors", "rails", "parts", "pins"] as const) st.contract.propose({ field: f, value: c.values[f] as never, by: f === "parts" ? "parts" : "architect", baseVersion: 0 })
	const msg = "Consistency violations for you at revision 7:\n- drc-errors: the 50×30 mm board (rev 6) fails JLCPCB 2-layer: 2 error(s), 0 unconnected; first: Hole clearance violation (actual 0.1412 mm). Give the router room"
	const out = mockScripts()["mock-architect"]([UserMessageItem.create(msg)])
	const call = JSON.parse((out[0] as unknown as { args: string }).args)
	assert.equal(call.field, "outline")
	assert.equal(call.value.widthMm, 52)
	assert.deepEqual(call.value.sizeReason, { kind: "routing", detail: "the 50×30 mm board (rev 6) failed KiCad DRC: Hole clearance violation (actual 0.1412 mm)" })
	void state
})

test("what counts as the board running out of room: unrouted pins, a via dropped on a pad, no spot for a part", async () => {
	const { ROUTING_FAILURE } = await import("../src/contract/space.ts")
	for (const line of ["Port pin1 on J1 is missing a trace", "Via hole at (5.91mm, -3.87mm) overlaps SMD pad U1.GPIO9 at (6.20mm, -4.00mm)", "tscircuit build failed: no room on the board for C3 at 35×25 mm"])
		assert.match(line, ROUTING_FAILURE)
	assert.doesNotMatch("Unknown footprint 'sot99' for U3", ROUTING_FAILURE)
})
