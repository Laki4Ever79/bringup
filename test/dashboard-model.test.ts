import assert from "node:assert/strict"
import { test } from "node:test"
import { AGENT_COLORS, boardFor, changedRefs, checkPills, contractDiff, parseBattery, prCards, scrubberModel } from "../src/dashboard/model.js"
import { fixtureContract } from "./fixture.ts"

let seq = 0
const ev = (type: string, payload: object) => ({ seq: seq++, at: `2026-10-31T12:00:${String(seq % 60).padStart(2, "0")}.000Z`, type, producerId: "x", payload })
const changed = (field: string, version: number, revision: number, by: string) => ev("contract.changed", { field, version, revision, by })

test("scrubber: one dot per revision, coloured by its author, and which board to show", () => {
	const events = [
		changed("requirements", 1, 1, "architect"),
		changed("parts", 1, 2, "parts"),
		ev("artifact.ready", { kind: "enclosure", revision: 2 }),
		changed("outline", 1, 3, "architect"),
		changed("pins", 1, 4, "architect"),
		ev("artifact.ready", { kind: "board", revision: 4 }),
		changed("pins", 2, 5, "firmware"),
		ev("artifact.ready", { kind: "board", revision: 5 }),
	]
	const m = scrubberModel(events)
	assert.deepEqual(m.dots.map((d: any) => [d.revision, d.field, d.by]), [[1, "requirements", "architect"], [2, "parts", "parts"], [3, "outline", "architect"], [4, "pins", "architect"], [5, "pins", "firmware"]])
	assert.equal(m.dots[4].color, AGENT_COLORS.firmware)
	assert.equal(m.dots[1].color, AGENT_COLORS.parts)
	assert.deepEqual(m.dots.map((d: any) => d.board), [false, false, false, true, true])
	assert.deepEqual(m.boards, [4, 5])
	assert.equal(boardFor(m, 3), null, "no board yet at rev 3")
	assert.equal(boardFor(m, 4), 4)
	assert.equal(boardFor(m, 99), 5)
})

test("the scrubber keeps a revision's first change when two fields share it", () => {
	const m = scrubberModel([changed("outline", 2, 9, "architect"), changed("outline", 2, 9, "architect")])
	assert.equal(m.dots.length, 1)
})

const base = () => fixtureContract().values as any

test("diff: pins added, moved and removed, keyed by signal", () => {
	const before = base().pins
	const after = [{ ...before[0], gpio: 4 }, { signal: "STATUS_LED", gpio: 10, partRef: "D1", partPin: "A" }]
	assert.deepEqual(contractDiff("pins", before, after), ["~ I2C_SDA GPIO8 → GPIO4", "− I2C_SCL → GPIO9 (U2.SCL)", "+ STATUS_LED → GPIO10 (D1.A)"])
})

test("diff: outline fields, parts by ref, connectors, and no change", () => {
	assert.deepEqual(contractDiff("outline", { widthMm: 50, heightMm: 30, thicknessMm: 1.6 }, { widthMm: 60, heightMm: 30, thicknessMm: 1.6 }), ["~ widthMm 50 → 60"])
	const parts = base().parts
	const swapped = parts.map((p: any) => (p.ref === "U2" ? { ...p, mpn: "SHT45-AD1B-R2" } : p))
	assert.deepEqual(contractDiff("parts", parts, [...swapped, { ref: "R1", role: "resistor", mpn: "0402WGF1001TCE", lcsc: "C11702", footprint: "0402", pins: [] }]), ["~ U2 SHT40-AD1B-R2 → SHT45-AD1B-R2", "+ R1 0402WGF1001TCE"])
	assert.deepEqual(contractDiff("connectors", base().connectors, [{ ...base().connectors[0], edge: "right" }]), ["~ J1 usb-c left @ 15 mm → usb-c right @ 15 mm"])
	assert.deepEqual(contractDiff("pins", base().pins, base().pins), [])
	assert.deepEqual(contractDiff("pins", undefined, base().pins), ["+ I2C_SDA → GPIO8 (U2.SDA)", "+ I2C_SCL → GPIO9 (U2.SCL)"])
})

test("changed refs: parts whose entry changed, plus both ends of changed pins", () => {
	const b = base()
	const a = { ...b, parts: b.parts.map((p: any) => (p.ref === "D1" ? { ...p, mpn: "other" } : p)), pins: [...b.pins, { signal: "STATUS_LED", gpio: 10, partRef: "D1", partPin: "A" }] }
	assert.deepEqual(changedRefs(b, a), ["D1", "U1"])
	assert.deepEqual(changedRefs(b, b), [])
	assert.deepEqual(changedRefs(null, b), [], "the first snapshot has nothing to compare with")
})

test("pull-request cards: requester → owner, diff from the snapshots around the applied revision", () => {
	const v1 = base()
	const v2 = { ...v1, pins: [...v1.pins, { signal: "STATUS_LED", gpio: 10, partRef: "D1", partPin: "A" }] }
	const snapshots = new Map<number, any>([[6, { revision: 6, values: v1 }], [7, { revision: 7, values: v2 }]])
	const events = [
		ev("change.proposed", { proposalId: "p1", field: "pins", by: "firmware", reason: "firmware drives a status LED" }),
		ev("change.decided", { proposalId: "p1", approved: true, by: "architect", reason: "GPIO10 is free" }),
		changed("pins", 2, 7, "firmware"),
		ev("change.proposed", { proposalId: "p2", field: "parts", by: "architect", reason: "add a button" }),
	]
	const cards = prCards(events, snapshots)
	assert.equal(cards.length, 2)
	assert.deepEqual(
		{ ...cards[0], at: undefined },
		{
			id: "p1", field: "pins", requester: "firmware", owner: "architect", reason: "firmware drives a status LED", needsEngineer: false, status: "approved", resolved: false,
			votes: [{ by: "architect", approved: true, reason: "GPIO10 is free" }], decidedBy: ["architect"], why: "GPIO10 is free", revision: 7, diff: ["+ STATUS_LED → GPIO10 (D1.A)"], at: undefined,
		},
	)
	assert.equal(cards[1].status, "pending")
	assert.equal(cards[1].owner, "parts")
	assert.deepEqual(cards[1].diff, [])
})

test("a rejected change has no applied revision and no diff", () => {
	const cards = prCards([ev("change.proposed", { proposalId: "p3", field: "outline", by: "enclosure", reason: "wider" }), ev("change.decided", { proposalId: "p3", approved: false, by: "architect", reason: "case is fixed" })], new Map())
	assert.equal(cards[0].status, "rejected")
	assert.equal(cards[0].revision, null)
	assert.deepEqual(cards[0].diff, [])
})

test("check pills: pending, running, ok, warn and error with counts and items", () => {
	assert.deepEqual(checkPills([]).map((p: any) => [p.key, p.state]), [["consistency", "pending"], ["grounding", "pending"], ["review", "pending"]])
	const pills = checkPills([
		ev("consistency.checked", { revision: 3, violations: [{ kind: "net-missing", message: "net I2C_SDA …" }, { kind: "outline-mismatch", message: "board is 50…" }] }),
		ev("grounding.checked", { revision: 3, findings: [{ kind: "unknown-pin", partRef: "U2", detail: "no pin SDX" }] }),
		ev("design.ready", { revision: 3, round: 1 }),
	])
	const [c, g, r] = pills
	assert.deepEqual([c.state, c.count, c.items], ["error", 2, ["net-missing: net I2C_SDA …", "outline-mismatch: board is 50…"]])
	assert.deepEqual([g.state, g.count, g.items], ["warn", 1, ["unknown-pin on U2: no pin SDX"]])
	assert.equal(r.state, "running")
	const later = checkPills([
		ev("consistency.checked", { revision: 4, violations: [] }),
		ev("grounding.checked", { revision: 4, findings: [] }),
		ev("review.completed", { revision: 4, verdict: "pass", findings: [{ severity: "minor", fields: ["rails"], issue: "LDO Iq", suggestion: "" }] }),
	])
	assert.deepEqual(later.map((p: any) => p.state), ["ok", "ok", "ok"])
	assert.deepEqual(later[2].items, ["minor · rails: LDO Iq"])
	assert.equal(checkPills([ev("review.completed", { revision: 4, verdict: "fail", findings: [{ severity: "blocker", fields: ["rails"], issue: "x", suggestion: "" }] })])[2].state, "error")
})

test("battery gauge reads the report's estimate", () => {
	assert.deepEqual(parseBattery("- Estimated battery life: 500 mAh / (0.05 mA + 0.055 mA) / 24 h = 198 days vs target 180 days\n"), { days: 198, targetDays: 180 })
	assert.deepEqual(parseBattery("- Estimated battery life: 45 days\n"), { days: 45, targetDays: null })
	assert.equal(parseBattery("- Estimated battery life: unknown (no battery capacity in the brief or requirements)"), null)
	assert.equal(parseBattery(""), null)
})

test("cards that need the engineer wait for change.resolved, and show every vote", () => {
	const events = [
		ev("change.proposed", { proposalId: "p9", field: "pins", by: "firmware", reason: "status LED", needsEngineer: true }),
		ev("change.decided", { proposalId: "p9", approved: true, by: "architect", reason: "GPIO10 is free" }),
	]
	let [c] = prCards(events, new Map())
	assert.equal(c.status, "waiting", "the owner voted, the engineer hasn't")
	assert.equal(c.needsEngineer, true)
	assert.deepEqual(c.votes, [{ by: "architect", approved: true, reason: "GPIO10 is free" }])
	events.push(ev("change.decided", { proposalId: "p9", approved: false, by: "engineer", reason: "keep GPIO10 for the button" }))
	events.push(ev("change.resolved", { proposalId: "p9", approved: false, reason: "keep GPIO10 for the button", decidedBy: ["architect", "engineer"] }))
	;[c] = prCards(events, new Map())
	assert.equal(c.status, "rejected")
	assert.equal(c.why, "keep GPIO10 for the button")
	assert.deepEqual(c.decidedBy, ["architect", "engineer"])
	assert.equal(c.votes.length, 2)
})

test("change.resolved decides even without a vote (timeout)", () => {
	const [c] = prCards([ev("change.proposed", { proposalId: "p8", field: "outline", by: "enclosure", reason: "", needsEngineer: false }), ev("change.resolved", { proposalId: "p8", approved: false, reason: "timeout", decidedBy: [] })], new Map())
	assert.equal(c.status, "rejected")
	assert.equal(c.why, "timeout")
})

test("the Review pill says off when the run has the brief review disabled", () => {
	const off = checkPills([ev("run.started", { review: false, engineerApproval: false, noHardware: true, bench: false }), ev("consistency.checked", { revision: 3, violations: [] })]).find((p: any) => p.key === "review")
	assert.deepEqual([off.state, off.items], ["off", ["the brief review is off for this run (--no-review)"]])
	const on = checkPills([ev("run.started", { review: true, engineerApproval: false, noHardware: true, bench: false })]).find((p: any) => p.key === "review")
	assert.equal(on.state, "pending")
})

test("the composer and the state pill: live, bench, waiting for a change, settled, stopped", async () => {
	const { runPhase } = await import("../src/dashboard/model.js")
	assert.deepEqual(runPhase({ settled: null, stay: true, alive: true, benchLive: false, stopped: false }), { bar: "live", pill: "LIVE", open: true })
	assert.deepEqual(runPhase({ settled: { settled: true }, stay: true, alive: true, benchLive: false, stopped: false }), { bar: "waiting", pill: "SETTLED · open", open: true })
	assert.deepEqual(runPhase({ settled: { settled: false }, stay: true, alive: true, benchLive: false, stopped: false }), { bar: "waiting", pill: "UNSETTLED · open", open: true })
	assert.deepEqual(runPhase({ settled: { settled: true }, stay: false, alive: true, benchLive: true, stopped: false }), { bar: "bench", pill: "SETTLED · bench live", open: true })
	assert.deepEqual(runPhase({ settled: { settled: true }, stay: true, alive: false, benchLive: false, stopped: false }), { bar: "settled", pill: "SETTLED", open: false })
	assert.deepEqual(runPhase({ settled: { settled: true }, stay: true, alive: true, benchLive: false, stopped: true }), { bar: "stopped", pill: "SETTLED", open: false })
	assert.deepEqual(runPhase({ settled: { settled: false }, stay: false, alive: false, benchLive: false, stopped: false }), { bar: "settled", pill: "UNSETTLED", open: false })
})

test("DRC errors inside one part's own footprint read amber with the reason; any other error stays red", () => {
	const board = (drc: object) => [{ seq: 1, at: "2026-10-31T12:00:01.000Z", type: "artifact.ready", producerId: "x", payload: { kind: "board", revision: 8, drc } }]
	const own = { rules: "JLCPCB 2-layer", errors: 2, warnings: 91, unconnected: 0, byType: { hole_clearance: 2 }, firstError: "Hole clearance violation (board setup constraints hole clearance 0.2000 mm; actual 0.1712 mm)", ownFootprint: { J1: 2 } }
	const pill = checkPills(board(own)).find((p) => p.key === "drc")!
	assert.equal(pill.state, "warn")
	assert.equal(pill.count, 2)
	assert.match(pill.items[0], /2 inside J1's own footprint/)
	assert.match(pill.items.join("\n"), /vendor land pattern/)
	const real = checkPills(board({ ...own, errors: 3 })).find((p) => p.key === "drc")!
	assert.equal(real.state, "error", "an error between parts is a real one")
	assert.equal(checkPills(board({ ...own, ownFootprint: undefined })).find((p) => p.key === "drc")!.state, "error", "older traces without the field stay as they were")
})

test("a clean DRC that relies on the USB-C vendor rule says so in the pill", () => {
	const board = (drc: object) => [{ seq: 1, at: "2026-10-31T12:00:01.000Z", type: "artifact.ready", producerId: "x", payload: { kind: "board", revision: 9, drc } }]
	const clean = { rules: "JLCPCB 2-layer", errors: 0, warnings: 0, unconnected: 0, byType: {}, firstError: null, ownFootprint: {}, exemptions: ["USB-C vendor land pattern (J1): pad ↔ its own locating hole ≥ 0.15 mm"] }
	const pill = checkPills(board(clean)).find((p) => p.key === "drc")!
	assert.equal(pill.state, "ok")
	assert.equal(pill.items[0], "DRC clean · 1 rule: USB-C vendor land pattern (J1): pad ↔ its own locating hole ≥ 0.15 mm")
})

test("DRC with no errors is clean even with KiCad's warnings (silkscreen, library notes); they stay in the popover", () => {
	const board = (drc: object) => [{ seq: 1, at: "2026-10-31T12:00:01.000Z", type: "artifact.ready", producerId: "x", payload: { kind: "board", revision: 8, drc } }]
	const drc = { rules: "JLCPCB 2-layer", errors: 0, warnings: 92, unconnected: 0, byType: { silk_over_copper: 50, lib_footprint_issues: 22, text_height: 17, silk_overlap: 3 }, firstError: null, ownFootprint: {}, exemptions: ["USB-C vendor land pattern (J1): pad ↔ its own locating hole ≥ 0.15 mm"] }
	const pill = checkPills(board(drc)).find((p) => p.key === "drc")!
	assert.equal(pill.state, "ok")
	assert.match(pill.items.join("\n"), /0 errors · 92 warnings/)
})

test("the composer's prompt matches the run: settled and waiting, unsettled and waiting, live, bench, ended", async () => {
	const { composerPrompt } = await import("../src/dashboard/model.js")
	assert.match(composerPrompt("waiting", { settled: true }), /^Settled\. Now change one thing/)
	assert.match(composerPrompt("waiting", { settled: false }), /^Not consistent yet/)
	assert.doesNotMatch(composerPrompt("waiting", { settled: false }), /Settled\./)
	assert.match(composerPrompt("live", null), /while the agents work/)
	assert.match(composerPrompt("bench", { settled: true }), /reflashes the board/)
	assert.match(composerPrompt("stopped", { settled: true }), /stopped/)
	assert.match(composerPrompt("settled", { settled: false }), /ended/)
})

test("a part that keeps its MPN and footprint says what did change, not \"SOT-23-5 → SOT-23-5\"", () => {
	const a = { ref: "U4", role: "charger", mpn: "TP4054-42-SOT25R", lcsc: "C32574", footprint: "SOT-23-5", pins: ["VCC", "GND"] }
	assert.deepEqual(contractDiff("parts", [a], [{ ...a, pins: ["VCC", "GND", "CHRG"] }]), ["~ U4 TP4054-42-SOT25R: pins changed"])
	assert.deepEqual(contractDiff("parts", [a], [{ ...a, lcsc: "C1", pins: ["X"] }]), ["~ U4 TP4054-42-SOT25R: lcsc, pins changed"])
	assert.deepEqual(contractDiff("parts", [a], [{ ...a, footprint: "SOT-23-6" }]), ["~ U4 SOT-23-5 → SOT-23-6"])
})

test("in a scripted run the composer says what the scripted agents understand: a width and the blink", async () => {
	const { composerPrompt } = await import("../src/dashboard/model.js")
	for (const bar of ["waiting", "live"]) {
		const p = composerPrompt(bar, { settled: true }, { scripted: true })
		assert.match(p, /add a temperature\/humidity sensor/)
		assert.match(p, /make it 40 mm wide/)
		assert.match(p, /blink faster when tilted/)
		assert.doesNotMatch(p, /swap a part|move a connector/, "the scripted agents don't do those")
	}
	assert.match(composerPrompt("waiting", { settled: true }, { scripted: true }), /^Settled\. Change one thing/)
	// A real-model run keeps the free prompt.
	assert.match(composerPrompt("waiting", { settled: true }, { scripted: false }), /swap a part/)
})

test("folds: the parts list and the revisions strip start collapsed, with a one-line header, and remember the choice", async () => {
	const { foldHeader, foldOpen, setFold } = await import("../src/dashboard/model.js")
	assert.equal(foldHeader("parts", { count: 18, totalUsd: 5.41 }), "Parts · 18 · $5.41")
	assert.equal(foldHeader("parts", { count: 18, totalUsd: null }), "Parts · 18")
	assert.equal(foldHeader("parts", { count: 0 }), "Parts")
	// The change on screen added parts: the collapsed bar says so.
	assert.equal(foldHeader("parts", { count: 19, totalUsd: 5.41, added: 2 }), "Parts · 19 · $5.41 · 2 new")
	assert.equal(foldHeader("parts", { count: 19, added: 1, changed: 1 }), "Parts · 19 · 1 new · 1 changed")
	assert.equal(foldHeader("revisions", { count: 9 }), "Revisions · 9")
	assert.equal(foldHeader("register", { count: 12 }), "Drawing register · 12 runs")
	assert.equal(foldHeader("register", { count: 1 }), "Drawing register · 1 run")
	const store = new Map<string, string>()
	const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
	assert.equal(foldOpen(storage, "parts"), false, "collapsed by default")
	setFold(storage, "parts", true)
	assert.equal(foldOpen(storage, "parts"), true)
	assert.equal(foldOpen(storage, "revisions"), false, "each fold on its own")
	// No storage (private mode throws): collapsed, and no crash.
	const broken = { getItem: () => { throw new Error("denied") }, setItem: () => { throw new Error("denied") } }
	assert.equal(foldOpen(broken, "parts"), false)
	setFold(broken, "parts", true)
})
