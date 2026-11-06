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

test("the logger's smallest board, by placement: every part fits on 36×21 mm, at 52% courtyard density or less", () => {
	const min = minimumBoard(logger())!
	assert.deepEqual([min.widthMm, min.heightMm, min.areaMm2, min.limitedBy], [36, 21, 756, "placement"])
	assert.ok(min.courtyardMm2 / min.areaMm2 < 0.7, `${min.courtyardMm2} mm² of courtyards`)
	assert.ok(placesAll(logger(), 36, 21))
	assert.ok(!placesAll(logger(), 35, 21))
})

test("a board over the limit with no reason wakes the architect; a recorded reason, or a compact board, doesn't", () => {
	const s = logger()
	assert.equal(s.values.outline!.sizeReason, undefined)
	const v = spaceChecks(s)
	assert.deepEqual(v.map((x) => [x.kind, x.affects[0]]), [["space-slack", "architect"]])
	assert.match(v[0].message, /50×30 mm \(1500 mm²\), 98% over the smallest it can be \(756 mm²/)
	s.values.outline = { ...s.values.outline!, sizeReason: { kind: "engineer-size", detail: "the brief asks for about 50 × 30 mm" } }
	assert.deepEqual(spaceChecks(s), [])
	const compact = logger()
	compact.values.outline = { ...compact.values.outline!, widthMm: 36, heightMm: 24 }
	// 864 mm² is 14% over 756: within the limit.
	assert.ok(864 / 756 - 1 <= SLACK_LIMIT)
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
	assert.match(lines, /the smallest it can be is 756 mm²/)
	assert.match(lines, /slack 98%, limit 15%, over it for a recorded reason: engineer-size/)
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
	assert.match(readFileSync(join(out, "report.md"), "utf8"), /Space: board 50×30 mm is 98% over the smallest it can be .*kept for a reason: engineer-size/)
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
	// Within the limit of the smallest board, and still a board, not a strip: near the brief's 5:3 proportions.
	const min = minimumBoard(contract)!
	assert.ok(w * h <= min.areaMm2 * (1 + SLACK_LIMIT), `${w}×${h}`)
	assert.ok(w / h > 1.3 && w / h < 2.2, `${w}×${h}`)
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
