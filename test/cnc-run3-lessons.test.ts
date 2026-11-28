// Real CNC run 3's lessons (out/real-runs/cc-cnc-3, 27 Nov 2026): Bringup's own build errors never reach an agent as
// theirs; no plane-width check judges a board whose build failed; the plan's estimate reads out/real-runs too.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { agentFacingError, isCodeFaultLine } from "../src/agents/code-faults.ts"
import { estimate } from "../src/system/estimate.ts"

// Run 3's board failure at revision 16, as the build reported it.
const RUN3 = [
	"tscircuit build failed (placement check, no layout built):",
	"Autorouting was skipped because the 5mm maximum length for .U7 > .VCC to .C30 > .pin1 cannot be satisfied: its endpoints are 8.61mm apart (4 additional violations). Every one of 32 layouts leaves a pin capacitor out of reach.",
	"Freerouting's layout: tscircuit build failed (exit 1):",
	'Invalid footprint prop on connector "J2": "dc091a250". Parser details: Invalid footprint function, got "dc", from string "dc091a250"',
	'Failed to fetch supplier footprint for <resistor#1312 name=".R5" /> (jlcpcb:C2912734): Component not found',
	"Circuits  0 passed 1 failed",
	"Build exiting with code 1: circuit build errors occurred",
].join("\n")

test("a catalog footprint tscircuit can't read and a supplier lookup are code's; an agent's own footprint is not", () => {
	const known = new Set(["dc091a250", "soic8"])
	assert.equal(isCodeFaultLine('Invalid footprint prop on connector "J2": "dc091a250". Parser details: x', known), true)
	assert.equal(isCodeFaultLine('Invalid footprint prop on chip "U3": "sot23_9pin_weird". Parser details: x', known), false)
	assert.equal(isCodeFaultLine('Failed to fetch supplier footprint for <resistor name=".R5" />: Component not found', known), true)
})

test("run 3's failure reaches the architect as the placement problem alone; a failure that is only code's wakes nobody", () => {
	const shown = agentFacingError(RUN3, new Set(["dc091a250"]))!
	assert.ok(shown)
	assert.match(shown, /U7 > \.VCC to \.C30/)
	assert.doesNotMatch(shown, /dc091a250|supplier footprint/)
	assert.match(shown, /2 lines Bringup itself caused/)
	const onlyCode = ["tscircuit build failed (exit 1):", 'Invalid footprint prop on connector "J2": "dc091a250". Parser details: x', "Build exiting with code 1: circuit build errors occurred"].join("\n")
	assert.equal(agentFacingError(onlyCode, new Set(["dc091a250"])), null)
	assert.equal(agentFacingError("tscircuit build failed:\nsome agent problem", new Set()), "tscircuit build failed:\nsome agent problem")
})

test("the plan's estimate reads the real runs kept under out/real-runs", () => {
	const out = mkdtempSync(join(tmpdir(), "bringup-est-"))
	const run = join(out, "real-runs", "cc-cnc-x")
	mkdirSync(run, { recursive: true })
	const at = (m: number) => new Date(Date.UTC(2026, 10, 27, 10, m)).toISOString()
	writeFileSync(join(run, "trace.jsonl"), [JSON.stringify({ at: at(0), type: "run.started", payload: { mock: false } }), JSON.stringify({ at: at(40), type: "design.settled", payload: { settled: true } })].join("\n"))
	writeFileSync(join(run, "contract.json"), JSON.stringify({ values: { cncTargets: { travelMm: { x: 1, y: 1, z: 1 } } } }))
	const e = estimate({ spec: { boards: [{ name: "b" }] } } as never, out, "cnc")
	assert.deepEqual(e.minutes, [40, 40])
})

test("the power plane's widths aren't judged while the board's build has failed", async () => {
	const { supplyWiring } = await import("../src/contract/consistency.ts")
	const { readFileSync } = await import("node:fs")
	const { resolve } = await import("node:path")
	// Run 3's contract at its end: its plane check reports narrow regions; with the board failed, none.
	const p = resolve(import.meta.dirname, "..", "..", "agent-mesh", "out", "real-runs", "cc-cnc-3", "contract.json")
	let c: any
	try {
		c = JSON.parse(readFileSync(p, "utf8"))
	} catch {
		return // the recorded run isn't on this machine
	}
	const snap = c.values ? c : { revision: 0, versions: {}, values: c }
	const narrow = (o: { boardFailed?: boolean }) => supplyWiring(snap, o).filter((v) => v.kind === "track-width-narrow" && /power layer/.test(v.message)).length
	assert.equal(narrow({ boardFailed: true }), 0)
})
