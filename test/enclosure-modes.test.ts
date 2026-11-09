// Who houses the board (engineer, 9 Nov 2026): requirements.enclosure "case" (default), "none" (a bare board) or "own"
// (the engineer's own housing, with a mechanical interface instead of a case). Plus two fixes from real run 5: a button
// sealed in a closed case, and the test current read off the battery rail's rating.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { checkConsistency, unreachableButtons } from "../src/contract/consistency.ts"
import { caseChecks } from "../src/contract/case.ts"
import { spaceChecks } from "../src/contract/space.ts"
import { caseNotNeeded } from "../src/agents/builders.ts"
import { addedForYou } from "../src/contract/added.ts"
import { complianceItems } from "../src/contract/compliance.ts"
import { interfaceMarkdown, mechanicalInterface } from "../src/contract/interface.ts"
import { expectedCurrents } from "../src/contract/testkit.ts"
import { DesignContract } from "../src/contract/contract.ts"
import { enclosureFromText, LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { runDesign } from "../src/run.ts"
import { fixtureContract } from "./fixture.ts"
import { tempDir } from "./helpers.ts"
import type { EnclosureMode } from "../src/contract/types.ts"

const logger = (enclosure?: EnclosureMode) => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	if (enclosure) s.values.requirements = { ...s.values.requirements!, enclosure }
	return s
}

test("only a design that wants our case builds and checks one", () => {
	assert.equal(caseNotNeeded(logger()), null)
	assert.equal(caseNotNeeded(logger("case")), null)
	assert.match(caseNotNeeded(logger("none"))!, /bare board/)
	assert.match(caseNotNeeded(logger("own"))!, /own housing/)
	// A case field too low for the connectors is a violation only when there is a case.
	const low = (mode?: EnclosureMode) => {
		const s = logger(mode)
		s.values.case = { wallMm: 2, heightMm: 4, features: [] }
		return s
	}
	assert.ok(caseChecks(low()).length > 0)
	assert.deepEqual(caseChecks(low("none")), [])
	assert.deepEqual(caseChecks(low("own")), [])
	const tall = (mode?: EnclosureMode) => {
		const s = logger(mode)
		s.values.case = { wallMm: 2, heightMm: 40, features: [] }
		return s
	}
	assert.ok(spaceChecks(tall()).some((v) => v.fields.includes("case")))
	assert.ok(!spaceChecks(tall("none")).some((v) => v.fields.includes("case")))
})

test("a button with no opening is a violation in our case, and fine on a bare board or in the engineer's housing", () => {
	const withButton = (mode?: EnclosureMode, listed = false) => {
		const s = logger(mode)
		s.values.parts = [...s.values.parts!, { ref: "SW1", role: "button", mpn: "TS-1187A-B-A-B", lcsc: "C318884", footprint: "pushbutton", pins: ["A", "B"] }]
		s.values.pins = [...s.values.pins!, { signal: "BUTTON", gpio: 3, partRef: "SW1", partPin: "A" }]
		if (listed) s.values.connectors = [...s.values.connectors!, { ref: "SW1", kind: "button", edge: "top", offsetMm: 25, widthMm: 4, heightMm: 3 }]
		return s
	}
	const v = unreachableButtons(withButton())
	assert.equal(v.length, 1)
	assert.deepEqual(v[0].affects, ["architect"])
	assert.match(v[0].message, /SW1 .* no opening/)
	assert.ok(checkConsistency(withButton(), {}).some((x) => x.kind === "button-unreachable"))
	assert.deepEqual(unreachableButtons(withButton(undefined, true)), [])
	assert.deepEqual(unreachableButtons(withButton("none")), [])
	assert.deepEqual(unreachableButtons(withButton("own")), [])
	// In the engineer's housing, the button is on the interface drawing.
	assert.deepEqual(mechanicalInterface(withButton("own"))!.buttons.map((b) => b.ref), ["SW1"])
})

test("requirements.enclosure takes only the three modes", () => {
	const c = new DesignContract()
	const r = logger().values.requirements!
	assert.match(String(c.validate({ field: "requirements", value: { ...r, enclosure: "box" } as never, by: "architect" })), /requirements\.enclosure must be one of "case", "none", "own"/)
	assert.equal(c.validate({ field: "requirements", value: { ...r, enclosure: "none" }, by: "architect" }), null)
})

test("the engineer is told: a case nobody asked for, a bare board's risks, the housing interface", () => {
	assert.deepEqual(addedForYou(logger()).map((i) => i.id).slice(0, 1), ["case"], "the brief didn't say: our case is an assumption")
	assert.ok(!addedForYou(logger("case")).some((i) => i.id === "case"), "asked for: not listed")
	const bare = addedForYou(logger("none"))
	assert.equal(bare[0].id, "no-case")
	assert.match(bare[0].shows, /static/)
	assert.doesNotMatch(bare.find((i) => i.id === "recovery-pads")!.shows, /open the case/)
	assert.doesNotMatch(bare.find((i) => i.id === "usb-wake")!.shows, /case closed/)
	assert.equal(addedForYou(logger("own"))[0].id, "own-housing")
	assert.match(addedForYou(logger("case")).find((i) => i.id === "usb-wake")!.shows, /case closed/)
	// The FCC label follows the housing.
	const label = (mode?: EnclosureMode) => complianceItems(logger(mode)).find((i) => /FCC ID/.test(i.item))!.why
	assert.match(label(), /case lettering/)
	assert.match(label("none"), /silkscreen/)
	assert.match(label("own"), /your own housing/)
})

test("the mechanical interface gives the housing designer every place it must match", () => {
	const m = mechanicalInterface(logger("own"))!
	assert.deepEqual(m.board, { widthMm: 50, heightMm: 30, thicknessMm: LOGGER_DESIGN.outline.thicknessMm })
	assert.deepEqual(m.openings.map((o) => o.ref), ["J1"])
	assert.deepEqual(m.airflow.map((a) => a.ref), ["U2"])
	assert.deepEqual(m.lights.map((l) => l.ref).sort(), ["D1", "D2"])
	assert.equal(m.antenna?.clearanceMm, 15)
	assert.deepEqual(m.bottomPads.map((p) => p.ref), ["TPR1", "TPR2"])
	assert.match(m.label!, /2AC7Z-ESPC3MINI1/)
	const md = interfaceMarkdown(m, "board.step")
	assert.match(md, /^# Mechanical interface/)
	assert.match(md, /needs outside air/)
})

test("the test kit's awake current is the board's own peak, not the battery rail's rating (real run 5)", () => {
	const s = logger()
	s.values.rails = [{ name: "VBAT", voltageV: 3.7, regulatorMaxMa: 500, loadMa: 500 }, ...s.values.rails!]
	assert.equal(expectedCurrents(s).awakeMa, Math.max(...LOGGER_DESIGN.rails.map((r) => r.loadMa)))
})

test("the scripted architect reads the housing from the brief", () => {
	assert.equal(enclosureFromText(readFileSync("briefs/logger-bare.md", "utf8")), "none")
	assert.equal(enclosureFromText(readFileSync("briefs/logger.md", "utf8")), "case")
	assert.equal(enclosureFromText("it goes into our own housing"), "own")
	assert.equal(enclosureFromText("a BLE beacon"), null)
})

test("a bare-board run builds no case and settles; 'into our own housing' writes the interface instead", { timeout: 180_000 }, async () => {
	const out = tempDir()
	const r = await runDesign({ brief: readFileSync("briefs/logger-bare.md", "utf8"), mock: true, noHardware: true, review: false, outDir: out, changes: ["it goes into our own housing"] })
	assert.equal(r.settled, true)
	assert.deepEqual(r.violations, [])
	const contract = JSON.parse(readFileSync(join(out, "contract.json"), "utf8"))
	assert.equal(contract.values.requirements.enclosure, "own")
	const trace = readFileSync(join(out, "trace.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
	const enclosureBuilds = trace.filter((e) => e.type === "artifact.ready" && e.payload.kind === "enclosure")
	assert.ok(enclosureBuilds.length >= 2 && enclosureBuilds.every((e) => e.payload.skipped), "every case build skipped, the mode change included")
	assert.ok(existsSync(join(out, "interface.md")))
	assert.match(readFileSync(join(out, "report.md"), "utf8"), /Enclosure: none \(requirements.enclosure "own"\); mechanical interface:/)
})
