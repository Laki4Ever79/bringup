import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { ApprovalRegistry } from "../src/approvals.ts"
import { DesignContract } from "../src/contract/contract.ts"
import { OWNERS, type ContractSnapshot, type FieldName } from "../src/contract/types.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import { commandRefused, editsToApply, Steering, type SteerFile } from "../src/runner/steer.ts"
import { SteerGate, STOPPED_ANSWER } from "../src/runner/steer-gate.ts"
import { parseCommand } from "../src/runner/steer-run.ts"
import { compileErrors, contractBreakage, editablePath, hunkFor, hunks, kindsTouched, revertHunk, suggestFieldFix, verifyEdit, type VerifyContext } from "../src/runner/steer-verify.ts"

const tick = () => new Promise((r) => setTimeout(r, 5))

test("a paused run holds every gate until it resumes; a paused agent holds only itself", async () => {
	const s = new Steering()
	s.register("parts", "agent")
	s.register("board-builder", "builder")
	let passed = 0
	s.setRunPaused(true)
	void s.gate("parts").then(() => passed++)
	await tick()
	assert.equal(passed, 0)
	assert.equal(s.anyHeld(), true)
	s.setRunPaused(false)
	await tick()
	assert.equal(passed, 1)
	s.pauseAgent("parts")
	assert.equal(s.held("parts"), true)
	assert.equal(s.held("board-builder"), false)
	s.resumeAgent("parts")
	assert.equal(s.anyHeld(), false)
})

test("redo bumps the agent's epoch and reruns its noted step; stop holds it until resume", () => {
	const s = new Steering()
	let reran = 0
	assert.equal(s.redoAgent("parts"), false, "nothing to redo before a step ran")
	s.noteStep("parts", "Consistency violations at revision 4\nmore", () => reran++)
	s.stopAgent("parts")
	assert.equal(s.epochOf("parts"), 1)
	assert.equal(s.snapshot().agents.find((a) => a.name === "parts")?.state, "stopped")
	assert.equal(s.redoAgent("parts"), true)
	assert.equal(reran, 1)
	assert.equal(s.epochOf("parts"), 2)
	assert.equal(s.held("parts"), false)
	assert.equal(s.snapshot().agents[0].lastStep?.summary, "Consistency violations at revision 4\nmore")
})

const transition = (nextStateId: string) => ({ nextStateId, input: {} }) as never

test("the gate holds a paused agent's next step, never its answer, and a stop ends a held step with a model answer (never idle)", async () => {
	const s = new Steering()
	const g = new SteerGate(s, "architect")
	assert.equal(g.isSatisfiedBy(transition("inference")), false, "nothing held: change control alone decides")
	s.setRunPaused(true)
	const t = transition("function_call") as { steerHold?: string }
	assert.equal(g.isSatisfiedBy(t as never), true)
	assert.equal(t.steerHold, "paused")
	assert.equal(g.isSatisfiedBy(transition("model_message")), false, "an answer always goes through")
	let out: { nextStateId: string; input: { answer?: { content?: { text?: string } } } } | null = null
	void g.handle(t as never).then((x) => (out = x as never))
	await tick()
	assert.equal(out, null, "waits while paused")
	s.stopAgent("architect")
	await tick()
	assert.equal(out!.nextStateId, "model_message")
	assert.match(JSON.stringify(out!.input.answer), new RegExp(STOPPED_ANSWER))
})

test("a loop held at its first step notes the step only once it really starts, so Redo reruns what last ran", async () => {
	const s = new Steering()
	s.setRunPaused(true)
	let reran = 0
	const g = new SteerGate(s, "parts", undefined, { summary: "the brief", redo: () => reran++ })
	assert.equal(s.snapshot().agents.find((a) => a.name === "parts")?.canRedo ?? false, false)
	const p = g.handle(transition("message_received"))
	s.setRunPaused(false)
	assert.equal(((await p) as { nextStateId: string }).nextStateId, "message_received")
	assert.equal(s.snapshot().agents.find((a) => a.name === "parts")?.lastStep?.summary, "the brief")
	s.redoAgent("parts")
	assert.equal(reran, 1)
})

test("a held change doesn't time out while the engineer has the run paused", async () => {
	const a = new ApprovalRegistry()
	let held = true
	a.holdWhile = () => held
	const id = a.open("pins", "parts")
	let decided: string | null = null
	void a.wait(id, 15).then((d) => (decided = d.reason))
	await new Promise((r) => setTimeout(r, 60))
	assert.equal(decided, null)
	held = false
	await new Promise((r) => setTimeout(r, 40))
	assert.equal(decided, "timeout")
})

const brief = readFileSync(resolve(import.meta.dirname, "../briefs/rover.md"), "utf8")
const rover = (): ContractSnapshot => ({ revision: 9, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) })
const contract = new DesignContract()
const validate = (f: FieldName, v: unknown) => contract.validate({ field: f, value: v as never, by: OWNERS[f] })

test("a narrower board that pushes a connector off its edge is caught; the fix is the nearest width that passes, not a revert", () => {
	const s = rover()
	const outline = { ...s.values.outline!, widthMm: 40 }
	const broke = contractBreakage(s, "outline", outline, brief, validate)
	assert.ok(broke.some((b) => b.kind === "connector-off-edge"), JSON.stringify(broke))
	const fix = suggestFieldFix(s, "outline", outline, brief, validate)!
	assert.equal(fix.source, "checks")
	const width = (fix.edit as { value: { widthMm: number } }).value.widthMm
	assert.ok(width > 40 && width < 60, `width ${width}`)
	assert.deepEqual(contractBreakage(s, "outline", (fix.edit as { value: unknown }).value, brief, validate), [])
	assert.match(fix.summary, /outline\.widthMm 40 → \d+/)
})

test("an edit the contract refuses is reported as invalid; an unchanged value breaks nothing", () => {
	const s = rover()
	assert.deepEqual(contractBreakage(s, "outline", s.values.outline, brief, validate), [])
	const pins = structuredClone(s.values.pins!)
	pins[0].signal = "lower-case"
	assert.equal(contractBreakage(s, "pins", pins, brief, validate)[0].kind, "invalid")
	assert.deepEqual(kindsTouched("pins").sort(), ["board", "firmware"])
})

test("the compiler's error points at the changed lines to put back; other changes stay", () => {
	const original = ["#include <x.h>", "void setup() {", "  a();", "}", "void loop() {", "  b();", "}"].join("\n")
	const edited = ["#include <x.h>", "// mine", "void setup() {", "  a();", "}", "void loop() {", "  b()", "}"].join("\n")
	const hs = hunks(original, edited)
	assert.equal(hs.length, 2)
	const log = "Compiling .pio/build/esp32c3/src/main.cpp.o\nsrc/main.cpp:7:6: error: expected ';' before '}' token\n"
	const errors = compileErrors(log, "firmware/rev-3/src/main.cpp")
	assert.deepEqual(errors, [{ line: 7, message: "expected ';' before '}' token" }])
	const h = hunkFor(hs, errors[0].line)!
	assert.equal(revertHunk(edited, h), ["#include <x.h>", "// mine", "void setup() {", "  a();", "}", "void loop() {", "  b();", "}"].join("\n"))
})

test("only the run's generated files can be edited, never a path out of the run", () => {
	assert.equal(editablePath("firmware/rev-3/src/main.cpp"), "firmware/rev-3/src/main.cpp")
	assert.equal(editablePath("../.env"), null)
	assert.equal(editablePath("firmware/rev-3/../../x"), null)
	assert.equal(editablePath("/etc/passwd"), null)
	assert.equal(editablePath("contract.json"), null)
})

test("a firmware file that doesn't compile: what broke, and the fix that compiles, checked by compiling it", async () => {
	const s = rover()
	const original = "void setup() {\n  a();\n}\nvoid loop() {\n  b();\n}\n"
	const files = new Map([["firmware/rev-9/src/main.cpp", original]])
	const compiled: string[] = []
	const written = new Map<string, string>()
	const ctx: VerifyContext = {
		snapshot: s, artifacts: {}, brief, outDir: "/run", validate, scratch: "/scratch",
		readFile: (p) => files.get(p) ?? null,
		writeFile: (p, c) => written.set(p, c),
		tools: {
			copyDir: async () => {},
			build: async () => ({ ok: true, detail: "" }),
			compileFirmware: async (dir) => {
				const text = written.get(`${dir}/src/main.cpp`)!
				compiled.push(dir)
				return text.includes("b()\n") && !text.includes("b();") ? { ok: false, log: "src/main.cpp:6:1: error: expected ';' before '}' token" } : { ok: true, log: "" }
			},
		},
	}
	const edited = "// note\nvoid setup() {\n  a();\n}\nvoid loop() {\n  b()\n}\n"
	const r = await verifyEdit({ kind: "file", path: "firmware/rev-9/src/main.cpp", content: edited }, ctx)
	assert.equal(r.ok, false)
	assert.match(r.broke[0].message, /main\.cpp:6: expected ';'/)
	assert.equal(r.fix?.source, "compiler")
	assert.equal((r.fix!.edit as { content: string }).content, "// note\nvoid setup() {\n  a();\n}\nvoid loop() {\n  b();\n}\n")
	assert.deepEqual(compiled, ["/scratch/fw", "/scratch/fw-fix"])
})

test("in a run without hardware tools a field edit is checked by the contract and the checks, and says its builds were not run", async () => {
	const s = rover()
	const r = await verifyEdit({ kind: "field", field: "outline", value: { ...s.values.outline!, widthMm: 58 } }, { snapshot: s, artifacts: {}, brief, outDir: "/run", validate, scratch: "/x", tools: null, readFile: () => null, writeFile: () => {} })
	assert.equal(r.ok, true, JSON.stringify(r.broke))
	assert.ok(r.builds.length > 0 && r.builds.every((b) => b.skipped))
})

test("steer commands: parsed from steer.jsonl lines, refused by the hub when they can't apply", () => {
	assert.deepEqual(parseCommand({ at: "t", action: "agent-stop", agent: "parts" }), { at: "t", action: "agent-stop", agent: "parts" })
	assert.equal(parseCommand({ action: "edit", edit: { kind: "field", field: "nope", value: 1 } }), null)
	assert.equal(parseCommand({ action: "rm -rf" }), null)
	const f: SteerFile = { live: true, paused: false, agents: [{ name: "parts", kind: "agent", state: "running", canRedo: false }], edits: [] }
	assert.match(commandRefused(f, { action: "edit", edit: { kind: "field", field: "outline", value: {} } })!, /pause the run first/)
	assert.match(commandRefused(f, { action: "agent-redo", agent: "parts" })!, /no step to redo/)
	assert.equal(commandRefused(f, { action: "pause" }), null)
	assert.match(commandRefused({ ...f, live: false }, { action: "pause" })!, /not running/)
	const edits = [
		{ id: "e1", at: "", edit: { kind: "field", field: "outline", value: 1 }, status: "ok" },
		{ id: "e2", at: "", edit: { kind: "field", field: "outline", value: 1 }, status: "broken", decision: "mine" },
		{ id: "e3", at: "", edit: { kind: "field", field: "outline", value: 1 }, status: "broken" },
		{ id: "e4", at: "", edit: { kind: "field", field: "outline", value: 1 }, status: "draft" },
	] as never
	assert.deepEqual(editsToApply(edits).map((e) => e.id), ["e1", "e2"])
})
