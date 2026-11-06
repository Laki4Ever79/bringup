import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { runDesign } from "../src/run.ts"
import { checkConsistency } from "../src/contract/consistency.ts"
import { BOARD_FIELDS, boardChangeWarning, builtFeatureChecks, caseOuter, DEFAULT_CASE, minCaseHeight } from "../src/contract/case.ts"
import { DesignContract } from "../src/contract/contract.ts"
import type { CaseSpec } from "../src/contract/types.ts"
import { BUILD_INPUTS } from "../src/agents/builders.ts"
import { FACT_ROLES } from "../src/agents/common.ts"
import { enclosureSpec } from "../src/tools/enclosure.ts"
import { stubEnclosure } from "../src/tools/stubs.ts"
import { caseFromRequest, requestedCaseWidth } from "../src/inference/scripts.ts"
import { appendDecision } from "../src/runner/decisions.ts"
import { prCards } from "../src/dashboard/model.js"
import { fixtureContract } from "./fixture.ts"
import { tempDir } from "./helpers.ts"

function withCase(c: CaseSpec) {
	const s = fixtureContract()
	s.values.case = c
	s.versions.case = 1
	return s
}
const caseKinds = (s: ReturnType<typeof fixtureContract>) => checkConsistency(s, {}).filter((v) => v.kind.startsWith("case-"))

test("the contract validates the case field", () => {
	const c = new DesignContract()
	const ok: CaseSpec = { wallMm: 2.5, heightMm: 16, features: [{ id: "m", kind: "wall-mount", sides: "top-bottom" }, { id: "t", kind: "text", text: "BRINGUP v2" }, { id: "h", kind: "hole", edge: "right", offsetMm: 15, diameterMm: 6 }] }
	assert.equal(c.validate({ field: "case", value: ok, by: "enclosure" }), null)
	for (const bad of [
		{ ...ok, wallMm: 0.8 },
		{ ...ok, heightMm: 100 },
		{ ...ok, features: [{ id: "a", kind: "text", text: "A" }, { id: "b", kind: "text", text: "B" }] },
		{ ...ok, features: [{ id: "a", kind: "lanyard", corner: "top-left" }, { id: "a", kind: "lanyard", corner: "top-right" }] },
		{ ...ok, features: [{ id: "a", kind: "text", text: "no <script>" }] },
		{ ...ok, features: [{ id: "a", kind: "hole", edge: "front", offsetMm: 1, diameterMm: 5 }] },
		{ ...ok, features: [{ id: "a", kind: "hole", edge: "left", offsetMm: 1, diameterMm: 40 }] },
	])
		assert.ok(c.validate({ field: "case", value: bad as never, by: "enclosure" }), JSON.stringify(bad))
})

test("without a case field the case is what it always was: 2 mm walls, a 14 mm body, no features", () => {
	const spec = enclosureSpec(fixtureContract()) as { wallMm: number; heightMm: number; features: unknown[] }
	assert.equal(spec.wallMm, DEFAULT_CASE.wallMm)
	assert.equal(spec.heightMm, DEFAULT_CASE.heightMm)
	assert.deepEqual(spec.features, [])
	assert.deepEqual(caseKinds(fixtureContract()), [])
})

test("a body too low for the USB-C's cutout wakes the case designer, and says how tall it must be", () => {
	const s = withCase({ ...DEFAULT_CASE, heightMm: 10 })
	const v = caseKinds(s)
	assert.deepEqual(v.map((x) => x.kind), ["case-too-low"])
	assert.deepEqual(v[0].affects, ["enclosure"])
	// floor 2 + standoff 3 + board 1.6 + J1 3.5 + margin 0.5 + lip 3
	assert.equal(minCaseHeight(s), 13.6)
	assert.match(v[0].message, /need 13\.6 mm/)
})

test("a hole must keep wall from the connector's cutout, fit the wall's height and stay on the wall", () => {
	// J1 (USB-C, 9 mm) is on the left wall at 15 mm: its cutout spans 10-20 mm.
	const into = caseKinds(withCase({ ...DEFAULT_CASE, features: [{ id: "h1", kind: "hole", edge: "left", offsetMm: 21, diameterMm: 5 }] }))
	assert.match(into[0].message, /runs into J1's cutout/)
	const clear = caseKinds(withCase({ ...DEFAULT_CASE, features: [{ id: "h1", kind: "hole", edge: "left", offsetMm: 25, diameterMm: 5 }] }))
	assert.deepEqual(clear, [])
	// Too big for a 14 mm body: the hole doesn't fit its wall, and the body is too low for it.
	const tooBig = caseKinds(withCase({ ...DEFAULT_CASE, features: [{ id: "h1", kind: "hole", edge: "right", offsetMm: 15, diameterMm: 12 }] }))
	assert.ok(tooBig.some((v) => /9 mm between the floor and the lid's lip/.test(v.message)), tooBig.map((v) => v.message).join("; "))
	assert.ok(tooBig.some((v) => v.kind === "case-too-low" && /need 18 mm/.test(v.message)))
	// The top wall runs from -2 to 56.9 mm: the board's 50 mm, the antenna's 4.9 mm past the right edge, 2 mm each end.
	const off = caseKinds(withCase({ ...DEFAULT_CASE, features: [{ id: "h1", kind: "hole", edge: "top", offsetMm: 56, diameterMm: 4 }] }))
	assert.match(off[0].message, /runs off the top wall/)
})

test("tabs on the same stretch of wall collide", () => {
	const s = withCase({ ...DEFAULT_CASE, features: [{ id: "mount", kind: "wall-mount", sides: "left-right" }, { id: "loop", kind: "lanyard", corner: "top-right" }] })
	s.values.outline = { ...s.values.outline!, heightMm: 12 }
	assert.match(caseKinds(s)[0].message, /mount and loop put tabs on the same stretch of the right wall/)
})

test("a built case is checked against the features it was asked for, not a rebuild still under way", () => {
	const asked: CaseSpec = { ...DEFAULT_CASE, features: [{ id: "t", kind: "text", text: "A VERY LONG LABEL TEXT" }] }
	const s = withCase(asked)
	const failed = [{ id: "t", kind: "text" as const, ok: false, issue: "does not fit on the lid" }]
	assert.match(builtFeatureChecks(s, { features: failed, featuresAsked: asked.features })[0].message, /could not be built: does not fit/)
	// The case was built before the text was added: the rebuild will bring it, so nothing is wrong yet.
	assert.deepEqual(builtFeatureChecks(s, { features: [], featuresAsked: [] }), [])
	// The stub reports every feature as built where the contract puts it.
	const stub = stubEnclosure(withCase({ ...DEFAULT_CASE, features: [{ id: "m", kind: "wall-mount", sides: "top-bottom" }] }), 1, tempDir())
	assert.equal(stub.features![0].ok, true)
	assert.equal(stub.features![0].yMm, 30 + 4 + 5)
})

test("only the case designer's changes to the board's fields carry the PCB warning", () => {
	assert.deepEqual([...BOARD_FIELDS].sort(), [...BUILD_INPUTS.board].sort())
	const outline = { widthMm: 50, heightMm: 30, thicknessMm: 1.6 }
	assert.match(boardChangeWarning("enclosure", "outline", outline, { ...outline, widthMm: 42 })!, /changes the PCB: the board outline 50×30 → 42×30 mm/)
	assert.equal(boardChangeWarning("enclosure", "case", DEFAULT_CASE, DEFAULT_CASE), null)
	assert.equal(boardChangeWarning("architect", "outline", outline, { ...outline, widthMm: 42 }), null)
	const j1 = { ref: "J1", kind: "usb-c" as const, edge: "left" as const, offsetMm: 15, widthMm: 9, heightMm: 3.5 }
	assert.match(boardChangeWarning("enclosure", "connectors", [j1], [{ ...j1, offsetMm: 10 }])!, /J1 to left@10 mm/)
})

test("the dashboard's change card carries the warning", () => {
	const cards = prCards([{ type: "change.proposed", at: "2026-11-06T10:00:00Z", payload: { proposalId: "p1", field: "outline", by: "enclosure", reason: "a 50 mm case", needsEngineer: true, warning: "This case change changes the PCB" } }], new Map())
	assert.equal(cards[0].status, "waiting")
	assert.equal(cards[0].warning, "This case change changes the PCB")
})

test("every designer that owns a field gets the design facts, the case designer, ml and test included", () => {
	for (const role of ["architect", "parts", "firmware", "ml", "test", "enclosure"] as const) assert.ok(FACT_ROLES.has(role), role)
	assert.ok(!FACT_ROLES.has("reviewer"))
})

test("the scripted case designer reads a request into the case field, clear of the checks", () => {
	const s = fixtureContract()
	// J1 is on the left: the gland goes on the first free wall, the right, and the body grows to take a 12.2 mm hole.
	const gland = caseFromRequest("add a cable gland to the case", s)
	const hole = gland.features.find((f) => f.kind === "hole")!
	assert.equal(hole.kind === "hole" && hole.edge, "right")
	assert.ok(gland.heightMm >= 12.2 + 1 + 3 + 2, `${gland.heightMm} mm`)
	assert.deepEqual(caseKinds(withCase(gland)), [])
	// Asked for on the left, where J1 is: moved along the wall until it clears the cutout.
	const left = caseFromRequest("add a 6 mm hole on the left of the case", s)
	assert.deepEqual(caseKinds(withCase(left)), [])
	const mount = caseFromRequest('add wall-mount tabs and engrave "BRINGUP" on the lid', s)
	assert.deepEqual(mount.features.map((f) => f.kind).sort(), ["text", "wall-mount"])
	assert.equal(mount.features.find((f) => f.kind === "wall-mount")!.kind === "wall-mount" && (mount.features.find((f) => f.kind === "wall-mount") as { sides: string }).sides, "top-bottom")
	assert.equal(requestedCaseWidth("make the case 50 mm wide"), 50)
	assert.equal(requestedCaseWidth("make it 40 mm wide"), null)
})

// The engineer, answering every case-driven board change the same way; returns the warnings it saw.
function engineer(out: string, approve: boolean): { warnings: string[]; stop(): void } {
	const warnings: string[] = []
	const answered = new Set<string>()
	const timer = setInterval(() => {
		const path = join(out, "trace.jsonl")
		if (!existsSync(path)) return
		for (const line of readFileSync(path, "utf8").trim().split("\n")) {
			const e = JSON.parse(line)
			if (e.type !== "change.proposed" || !e.payload.needsEngineer || answered.has(e.payload.proposalId)) continue
			answered.add(e.payload.proposalId)
			warnings.push(e.payload.warning ?? "")
			appendDecision(out, { proposalId: e.payload.proposalId, approve, reason: approve ? "fine, shrink the board" : "keep the board" })
		}
	}, 100)
	return { warnings, stop: () => clearInterval(timer) }
}

const trace = (out: string) => readFileSync(join(out, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))

test("case features, then a case size the board must follow: the engineer is warned, confirms, and the board shrinks", { timeout: 240_000 }, async () => {
	const out = tempDir()
	const you = engineer(out, true)
	const r = await runDesign({ brief: readFileSync("briefs/logger.md", "utf8"), mock: true, noHardware: true, review: false, outDir: out, changes: ['add wall-mount tabs and engrave "BRINGUP" on the lid', "make the case 50 mm wide"], changeTimeoutMs: 30_000 })
	you.stop()
	assert.equal(r.settled, true)
	assert.deepEqual(r.violations, [])
	const contract = JSON.parse(readFileSync(join(out, "contract.json"), "utf8"))
	assert.deepEqual(contract.values.case.features.map((f: { kind: string }) => f.kind).sort(), ["text", "wall-mount"])
	// 50 mm case = board + 2 × (2 mm clearance + 2 mm wall) + the module's antenna, 4.9 mm past the board's edge.
	assert.equal(contract.values.outline.widthMm, 37.1)
	assert.equal(caseOuter(contract).widthMm, 50)
	assert.equal(you.warnings.length, 1, "one board change, one question")
	assert.match(you.warnings[0], /changes the PCB: the board outline 50×30 → 37.1×30 mm/)
	const events = trace(out)
	// The features alone never asked the engineer: only the board change did.
	const proposals = events.filter((e) => e.type === "change.proposed")
	assert.ok(proposals.every((e) => e.payload.needsEngineer === (e.payload.by === "enclosure" && e.payload.field === "outline")))
	const resolved = events.find((e) => e.type === "change.resolved" && e.payload.proposalId === proposals.find((p) => p.payload.field === "outline").payload.proposalId)
	assert.deepEqual([...resolved.payload.decidedBy].sort(), ["architect", "engineer"])
	assert.ok(events.some((e) => e.type === "artifact.ready" && e.payload.kind === "board" && e.payload.revision >= contract.revision - 1), "the board rebuilt")
})

test("rejected: the board stays, the case keeps its size, and the design settles", { timeout: 240_000 }, async () => {
	const out = tempDir()
	const you = engineer(out, false)
	const r = await runDesign({ brief: readFileSync("briefs/logger.md", "utf8"), mock: true, noHardware: true, review: false, outDir: out, changes: ["make the case 50 mm wide"], changeTimeoutMs: 30_000 })
	you.stop()
	assert.equal(r.settled, true)
	assert.deepEqual(r.violations, [])
	const contract = JSON.parse(readFileSync(join(out, "contract.json"), "utf8"))
	assert.equal(contract.values.outline.widthMm, 50)
	assert.equal(you.warnings.length, 1)
	assert.ok(!trace(out).some((e) => e.type === "contract.changed" && e.payload.field === "outline" && e.payload.by === "enclosure"))
})

test("the dashboard's contract panel lists every contract field (it had missed model and test)", async () => {
	const { FIELDS } = await import("../src/contract/types.ts")
	const page = readFileSync("src/dashboard/page.html", "utf8")
	const listed = JSON.parse(/const FIELDS = (\[[^\]]*\])/.exec(page)![1])
	assert.deepEqual(listed, [...FIELDS])
})
