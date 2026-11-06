// The production test as one more domain of the contract. The test agent owns which nets get a test pad and the
// current limits a board passes at; from the same contract Bringup generates the board's bottom-side test pads, the
// bed-of-nails fixture that probes them, the factory-test firmware and the test plan. When the board changes, all four
// follow, and these checks wake the test agent when its own field no longer fits the design.
import { generatedNets, testPoints, type TestPoint } from "../codegen/circuit.ts"
import { estimatePower } from "./power.ts"
import type { AgentRole, ContractSnapshot, FieldName, TestSpec } from "./types.ts"

export interface TestViolation {
	kind: "test-uncovered" | "test-orphan" | "test-limit" | "test-unplaced" | "fixture-mismatch"
	message: string
	fields: FieldName[]
	affects: AgentRole[]
}

// The rails people name ("3V3") and the generator's net for each ("V3V3": a net name can't start with a digit).
const netOf = (rail: string) => (/^\d/.test(rail) ? `V${rail}` : rail)
const railOf = (net: string) => net.replace(/^V(\d)/, "$1")

// Power nets a test pad may sit on. The fixture must reach ground, the logic supply and the battery node; VBUS is
// optional: the station plugs into the USB-C port anyway (the factory test reports over USB), which powers the board,
// and a VBUS pad pulled a via beside the connector's locating hole (45 mm logger: 2 hole-clearance errors).
const POWER = ["GND", "3V3", "VBUS", "VBAT"]
const OPTIONAL_POWER = new Set(["VBUS"])

// The nets a design can probe: its contract signals and the power nets the generator wires (with rail names).
export function probeableNets(s: ContractSnapshot): { signals: string[]; power: string[] } {
	const nets = new Set([...generatedNets(s).keys()].map(railOf))
	return { signals: (s.values.pins ?? []).map((p) => p.signal), power: POWER.filter((n) => nets.has(n)) }
}

// The board's own current, as the factory test sees it: the busiest rail's peak while awake, and the sleep floor plus
// every regulator's quiescent current while asleep. A limit below these fails every good board.
export function expectedCurrents(s: ContractSnapshot): { awakeMa: number | null; sleepUa: number | null } {
	const e = estimatePower(s, "")
	const peak = e.rails.length ? Math.max(...e.rails.map((r) => r.peakMa)) : null
	const sleepUa = e.sleep ? e.sleep.sleepUa + e.regulatorIqUa : null
	return { awakeMa: peak, sleepUa }
}

// What the test agent writes when the engineer asks for a production test: every signal and power net probed, and
// limits with margin over the design's own figures (awake +20 %, asleep +50 %: sleep currents vary more part to part).
export function defaultTestSpec(s: ContractSnapshot): TestSpec {
	const { signals, power } = probeableNets(s)
	const { awakeMa, sleepUa } = expectedCurrents(s)
	return { points: [...signals, ...power.filter((n) => !OPTIONAL_POWER.has(n))], awakeMaxMa: Math.ceil((awakeMa ?? 100) * 1.2), sleepMaxUa: Math.ceil((sleepUa ?? 50) * 1.5) }
}

export function testChecks(s: ContractSnapshot): TestViolation[] {
	const t = s.values.test
	if (!t) return []
	const out: TestViolation[] = []
	const { signals, power } = probeableNets(s)
	// A net is owed a pad only if the board has room for one: with every required net asked for, the ones the
	// placement can't fit are waived, or "add it" and "no room for it" would contradict each other forever.
	const required = [...signals, ...power.filter((n) => !OPTIONAL_POWER.has(n))]
	const noRoom = new Set(testPoints({ ...s, values: { ...s.values, test: { ...t, points: [...new Set([...t.points, ...required])] } } }).unplaced)
	const uncovered = required.filter((n) => !t.points.includes(n) && !noRoom.has(n))
	if (uncovered.length)
		out.push({ kind: "test-uncovered", message: `the fixture can't reach ${uncovered.join(", ")}: no test pad on ${uncovered.length > 1 ? "these nets" : "this net"}; add ${uncovered.length > 1 ? "them" : "it"} to test.points`, fields: ["test", "pins"], affects: ["test"] })
	const orphans = t.points.filter((n) => !signals.includes(n) && !power.includes(n))
	if (orphans.length)
		out.push({ kind: "test-orphan", message: `test.points names ${orphans.join(", ")}, which the design no longer has: drop ${orphans.length > 1 ? "them" : "it"}`, fields: ["test", "pins"], affects: ["test"] })
	const { awakeMa, sleepUa } = expectedCurrents(s)
	if (awakeMa !== null && t.awakeMaxMa < awakeMa)
		out.push({ kind: "test-limit", message: `test.awakeMaxMa ${t.awakeMaxMa} mA is below the design's own peak of ${awakeMa} mA: every good board would fail; raise it`, fields: ["test", "rails"], affects: ["test"] })
	if (sleepUa !== null && t.sleepMaxUa < sleepUa)
		out.push({ kind: "test-limit", message: `test.sleepMaxUa ${t.sleepMaxUa} µA is below the design's own sleep current of ${+sleepUa.toFixed(1)} µA (MCU floor and regulators): every good board would fail; raise it`, fields: ["test", "parts"], affects: ["test"] })
	const { unplaced } = testPoints(s)
	if (unplaced.length)
		out.push({ kind: "test-unplaced", message: `no room on the board's underside for a test pad on ${unplaced.join(", ")} (2.54 mm grid, 3 mm from the edge, clear of the module, connectors and holes): drop the least useful point, or ask for a larger board`, fields: ["test", "outline"], affects: ["test"] })
	return out
}

// The fixture against the board that was really built: each probe must sit over its test pad, and the pad must be on
// the probe's net. Nobody is woken: the test-kit builder rebuilds from the same placement.
export function fixtureChecks(s: ContractSnapshot, board: { placements?: Record<string, { xMm: number; yMm: number }>; nets: Record<string, string[]> } | undefined, kit: { probes: TestPoint[] } | undefined): TestViolation[] {
	if (!s.values.test || !board?.placements || !kit) return []
	const out: TestViolation[] = []
	for (const p of kit.probes) {
		const pad = board.placements[p.ref]
		if (!pad) {
			out.push({ kind: "fixture-mismatch", message: `the fixture has a probe for ${p.ref} (${p.net}), but the board has no ${p.ref}`, fields: ["test"], affects: [] })
			continue
		}
		const off = Math.hypot(pad.xMm - p.xMm, pad.yMm - p.yMm)
		if (off > 0.1) out.push({ kind: "fixture-mismatch", message: `the fixture's probe for ${p.ref} (${p.net}) is ${off.toFixed(2)} mm from the pad the board has`, fields: ["test"], affects: [] })
		const net = Object.entries(board.nets).find(([, ends]) => ends.some((e) => e.startsWith(`${p.ref}.`)))?.[0]
		if (net !== undefined && net !== netOf(p.net) && net !== p.net) out.push({ kind: "fixture-mismatch", message: `${p.ref} is on ${net} on the board, but the fixture probes it as ${p.net}`, fields: ["test"], affects: [] })
	}
	return out
}

export interface TestStep {
	id: string
	// Who measures: the fixture's meter on a test pad, or the factory-test firmware on the board itself.
	by: "fixture" | "firmware"
	what: string
	pass: string
	probe?: string
}

export interface TestPlan {
	revision: number
	probes: TestPoint[]
	steps: TestStep[]
}

// The steps, in the order a station runs them: power first (a short would make every later step meaningless), then
// current, then the firmware's self-test, which the fixture watches on the test pads.
export function testPlan(s: ContractSnapshot): TestPlan {
	const t = s.values.test
	const { placed } = testPoints(s)
	const tp = (net: string) => placed.find((p) => p.net === net)?.ref
	const steps: TestStep[] = []
	if (!t) return { revision: s.revision, probes: placed, steps }
	const parts = s.values.parts ?? []
	// The limits are the battery-fed rails' current (expectedCurrents). With a charger on the board, USB would also be
	// charging whatever sits on VBAT, so the current steps run from a battery simulator on the VBAT pad, USB unplugged.
	const battery = t.points.includes("VBAT")
	const from = battery ? "drawn from a battery simulator on the VBAT pad (3.7 V), USB unplugged" : "drawn from the USB supply"
	if (t.points.includes("GND")) steps.push({ id: "gnd", by: "fixture", what: "board ground to the station's ground", pass: "< 1 Ω", probe: tp("GND") })
	steps.push({ id: "vbus", by: "fixture", what: t.points.includes("VBUS") ? "USB supply at the board" : "USB supply, at the station's USB-C cable that powers the board", pass: "4.75–5.25 V (USB 2.0 VBUS range)", probe: tp("VBUS") })
	if (t.points.includes("3V3")) steps.push({ id: "3v3", by: "fixture", what: "3V3 rail from the regulator", pass: "3.20–3.40 V (3.3 V ±3 %)", probe: tp("3V3") })
	if (battery) steps.push({ id: "vbat", by: "fixture", what: "charger output on the VBAT pad, USB in, the battery simulator sinking current", pass: "4.1–4.3 V (Li-ion charge voltage)", probe: tp("VBAT") })
	steps.push({ id: "awake", by: "fixture", what: `supply current while the self-test runs, ${from}`, pass: `≤ ${t.awakeMaxMa} mA` })
	steps.push({ id: "sleep", by: "fixture", what: `supply current in deep sleep after the self-test, ${from}`, pass: `≤ ${t.sleepMaxUa} µA` })
	for (const p of s.values.pins ?? []) {
		const role = parts.find((x) => x.ref === p.partRef)?.role
		const probe = tp(p.signal)
		if (role === "led") steps.push({ id: `out-${p.signal}`, by: "firmware", what: `${p.signal} (GPIO${p.gpio}) drives ${p.partRef}: the firmware drives it high and low and reads the pin back (a pin shorted to a rail fails)`, pass: "reads back what it drove; the fixture sees 0 V then 3.3 V on the pad, which proves the trace", probe })
		else if (role === "button") steps.push({ id: `in-${p.signal}`, by: "firmware", what: `${p.signal} (GPIO${p.gpio}) from ${p.partRef}: idle level with the pull-up`, pass: "reads high (not shorted to GND)", probe })
		// One firmware step proves a bus: the sensor's ACK needs both I2C lines, the mic's samples need its clock and data.
		else if (role === "sensor" && p.partPin === "SDA") steps.push({ id: "i2c-sensor", by: "firmware", what: `the ${parts.find((x) => x.ref === p.partRef)?.mpn} answers at its I2C address (proves SDA, SCL, their pull-ups and its supply)`, pass: "ACK", probe })
		else if (role === "microphone" && p.partPin === "SD") steps.push({ id: "mic", by: "firmware", what: `the microphone's data line (${p.signal}) carries samples while clocked (proves SCK, WS and SD)`, pass: "not stuck: samples vary", probe })
		else if (role === "sensor" || role === "microphone") continue
		else if (probe) steps.push({ id: `net-${p.signal}`, by: "fixture", what: `${p.signal} (GPIO${p.gpio} → ${p.partRef}.${p.partPin}) reaches its test pad`, pass: "the fixture sees the pad follow the line (no self-test for this part yet)", probe })
	}
	return { revision: s.revision, probes: placed, steps }
}

export function testPlanMarkdown(p: TestPlan, s: ContractSnapshot): string {
	const t = s.values.test
	return [
		`# Production test, design revision ${p.revision}`,
		"",
		"Generated by Bringup from the design contract. The fixture, the factory-test firmware and this plan come from the",
		"same revision; a later design change regenerates all three.",
		"",
		"## Test pads (bottom side, from the board's bottom-left corner, top view)",
		"",
		"| Pad | Net | x mm | y mm |",
		"| --- | --- | --- | --- |",
		...p.probes.map((x) => `| ${x.ref} | ${x.net} | ${x.xMm} | ${x.yMm} |`),
		"",
		"## Steps",
		"",
		"| # | By | What | Pass | Pad |",
		"| --- | --- | --- | --- | --- |",
		...p.steps.map((x, i) => `| ${i + 1} | ${x.by} | ${x.what} | ${x.pass} | ${x.probe ?? ""} |`),
		"",
		t ? `Limits: awake ≤ ${t.awakeMaxMa} mA, asleep ≤ ${t.sleepMaxUa} µA (the test agent's, checked against the design's power budget).` : "",
		"",
		"The firmware steps print `BRINGUP-TEST <id> PASS|FAIL <detail>` and a final `BRINGUP-TEST done <passed>/<total>` on",
		"the board's USB serial. Fixture: 1.5 mm pads on a 2.54 mm grid suit common 100-mil pogo pins; the probe holes in",
		"fixture.stl are sized for press-fit receptacles (see fixture.json), so check them against the probes you buy.",
		"",
	].join("\n")
}

// include/testkit.h for the factory-test firmware: which self-tests to run, on which pins (pins.h names them).
export function testkitHeader(s: ContractSnapshot): string {
	const parts = s.values.parts ?? []
	const pins = s.values.pins ?? []
	const of = (role: string) => pins.filter((p) => parts.find((x) => x.ref === p.partRef)?.role === role)
	const macro = (sig: string) => `PIN_${sig}`
	const leds = of("led")
	const buttons = of("button")
	const sda = of("sensor").find((p) => p.partPin === "SDA")
	const scl = of("sensor").find((p) => p.partPin === "SCL")
	const mic = of("microphone")
	const micPin = (pin: string) => mic.find((p) => p.partPin === pin)
	const lines = ["// Generated by Bringup from the design contract (test field). Do not edit.", "#pragma once", '#include "pins.h"', ""]
	lines.push(`#define TEST_OUTPUTS {${leds.map((p) => macro(p.signal)).join(", ")}}`, `#define TEST_OUTPUT_NAMES {${leds.map((p) => JSON.stringify(p.signal)).join(", ")}}`, `#define TEST_OUTPUT_COUNT ${leds.length}`)
	lines.push(`#define TEST_INPUTS {${buttons.map((p) => macro(p.signal)).join(", ")}}`, `#define TEST_INPUT_NAMES {${buttons.map((p) => JSON.stringify(p.signal)).join(", ")}}`, `#define TEST_INPUT_COUNT ${buttons.length}`)
	if (sda && scl) lines.push("#define TEST_I2C_SENSOR 1", `#define TEST_I2C_SDA ${macro(sda.signal)}`, `#define TEST_I2C_SCL ${macro(scl.signal)}`)
	if (micPin("SCK") && micPin("WS") && micPin("SD")) lines.push("#define TEST_MIC 1", `#define TEST_MIC_SCK ${macro(micPin("SCK")!.signal)}`, `#define TEST_MIC_WS ${macro(micPin("WS")!.signal)}`, `#define TEST_MIC_SD ${macro(micPin("SD")!.signal)}`)
	lines.push(`#define TEST_REVISION ${s.revision}`, "")
	return lines.join("\n")
}
