// Fixes from the first real-model system run (9 Nov 2026): links handed to an empty board, a revision cap that kept
// re-arming, a review finding that created a model, connectors crowding one edge; and the wake button's window.
import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ModelMessageItem, UserMessageItem, FunctionCallOutputItem, type ContextItem } from "@mozaik-ai/core"
import { connectorClashes, ledOnCathode, moduleEdgeBlocked } from "../src/contract/consistency.ts"
import { usbWake } from "../src/codegen/circuit.ts"
import { parseArgs } from "../src/main.ts"
import { linkChecks } from "../src/contract/links.ts"
import { addedForYou } from "../src/contract/added.ts"
import { boardLinks } from "../src/system/derive.ts"
import { ROOT, runDesign } from "../src/run.ts"
import { LOGGER_DESIGN, mockScripts, ROVER_MOTION } from "../src/inference/scripts.ts"
import { toolCall, type Script } from "../src/inference/scripted-runner.ts"
import { state } from "../src/runtime.ts"
import type { Env } from "../src/tools/env.ts"
import type { SystemSpec } from "../src/system/spec.ts"
import { runSystem } from "../src/system/run.ts"
import { defaultAssembly } from "../src/system/assembly.ts"
import type { startRunProcess } from "../src/runner/spawn-run.ts"
import { fixtureContract } from "./fixture.ts"
import { tempDir } from "./helpers.ts"

const bare: Env = { root: ROOT, tsci: null, kicad: null, python: null, pio: null }
const logger = () => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	return s
}

test("link checks wait until the board is drafted: an MCU and its pins", () => {
	const spec: SystemSpec = { name: "s", boards: [{ name: "a", brief: "a.md" }, { name: "b", brief: "b.md" }], links: [{ id: "L1", kind: "uart", a: { board: "a" }, b: { board: "b" }, cable: { lengthMm: 300 } }] }
	const empty = fixtureContract()
	empty.values = { links: boardLinks(spec, "a") }
	assert.deepEqual(linkChecks(empty), [], "nothing to fix before the brief is drafted")
	const drafted = logger()
	drafted.values.links = boardLinks(spec, "a")
	assert.ok(linkChecks(drafted).length > 0)
})

test("connectors that crowd one edge are a violation for the architect, before any build", () => {
	const s = logger()
	s.values.connectors = [...s.values.connectors!, { ref: "SW1", kind: "button", edge: "right", offsetMm: 14, widthMm: 5.8, heightMm: 3 }, { ref: "JL1", kind: "header", edge: "right", offsetMm: 7, widthMm: 5.8, heightMm: 3 }]
	const v = connectorClashes(s)
	assert.equal(v.length, 1)
	assert.match(v[0].message, /SW1 \(right@14 mm\) and JL1 \(right@7 mm\) (overlap on the board|leave 0\.2 mm of case wall)/)
	assert.deepEqual(v[0].affects, ["architect"])
	// Far apart on the same edge: fine. A bare board has no case wall to keep.
	s.values.connectors = s.values.connectors.map((k) => (k.ref === "JL1" ? { ...k, offsetMm: 5 } : k.ref === "SW1" ? { ...k, offsetMm: 20 } : k))
	assert.deepEqual(connectorClashes(s), [])
	assert.deepEqual(connectorClashes(logger()), [])
})

test("a wake button's longer window is listed for the engineer, with its cost and where to change it", () => {
	const s = logger()
	assert.ok(!addedForYou(s).some((i) => i.id === "button-window"))
	s.values.pins = [...s.values.pins!, { signal: "BUTTON", gpio: 3, partRef: "SW1", partPin: "A" }]
	const item = addedForYou(s).find((i) => i.id === "button-window")!
	assert.match(item.what, /visible for a phone for 30 s/)
	assert.match(item.cost, /0\.8–2\.6 C/)
	assert.match(item.change, /BUTTON_ADVERTISE_MS/)
})

const lastUser = (items: ContextItem[]) => (items.findLast((i) => i instanceof UserMessageItem) as UserMessageItem | undefined)?.content.text ?? ""
const steps = (items: ContextItem[]) => items.slice(items.findLastIndex((i) => i instanceof UserMessageItem)).filter((i) => i instanceof FunctionCallOutputItem).length

test("a review finding that names the model doesn't create one", { timeout: 90_000 }, async () => {
	const outDir = tempDir()
	let mlTurns = 0
	const reviewer: Script = (items) => {
		if (items.at(-1) instanceof UserMessageItem) return [toolCall("submit_review", { verdict: "fail", findings: [{ severity: "major", fields: ["rails", "model"], issue: "the battery margin", suggestion: "check the averages" }] })]
		return [ModelMessageItem.rehydrate({ text: "submitted" })]
	}
	const ml: Script = (items) => {
		if (lastUser(items).startsWith("Review findings")) mlTurns++
		return [ModelMessageItem.rehydrate({ text: "nothing" })]
	}
	await runDesign({ brief: readFileSync(join(ROOT, "briefs/logger.md"), "utf8"), mock: true, outDir, env: bare, noHardware: true, maxReviewRounds: 1, timeoutMs: 60_000, scripts: { ...mockScripts(), "mock-reviewer": reviewer, "mock-ml": ml } })
	assert.equal(mlTurns, 0, "no model in the design: the finding isn't the ML engineer's")
	assert.equal(JSON.parse(readFileSync(join(outDir, "contract.json"), "utf8")).values.model, undefined)
})

test("past the revision cap, the agents' own changes don't re-arm a run that stays up; only the engineer does", { timeout: 90_000 }, async () => {
	const outDir = tempDir()
	// An architect that, once the brief is drafted, keeps nudging the board's width in one long turn.
	const base = mockScripts()["mock-architect"]
	const churn: Script = (items) => {
		if (!lastUser(items).startsWith("Brief")) return base(items)
		if (steps(items) < 5) return base(items)
		if (steps(items) > 40) return [ModelMessageItem.rehydrate({ text: "done" })]
		const o = state().contract.get("outline")!
		return [toolCall("propose_contract_change", { field: "outline", value: { ...o, widthMm: 50 + (steps(items) % 2) }, baseVersion: state().contract.version("outline"), reason: "churn" })]
	}
	let release = () => {}
	const until = new Promise<void>((r) => (release = r))
	const done = runDesign({ brief: readFileSync(join(ROOT, "briefs/logger.md"), "utf8"), mock: true, outDir, env: bare, noHardware: true, review: false, maxRevisions: 10, stay: { until }, scripts: { ...mockScripts(), "mock-architect": churn } })
	await new Promise((r) => setTimeout(r, 8000))
	release()
	await done
	const trace = readFileSync(join(outDir, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
	const settles = trace.filter((e) => e.type === "design.settled")
	assert.equal(settles.length, 1, `settled ${settles.length} times: ${JSON.stringify(settles.map((e) => e.payload))}`)
	assert.equal(settles[0].payload.settled, false)
})

test("a status LED driven on its cathode is a violation: its anode would be unconnected (real system run 1)", () => {
	const s = logger()
	s.values.pins = [...s.values.pins!, { signal: "STATUS_LED", gpio: 10, partRef: "D1", partPin: "A" }]
	assert.deepEqual(ledOnCathode(s), [])
	s.values.pins = s.values.pins.map((p) => (p.signal === "STATUS_LED" ? { ...p, partPin: "K" } : p))
	const v = ledOnCathode(s)
	assert.equal(v.length, 1)
	assert.match(v[0].message, /assign STATUS_LED to D1\.A/)
})

test("USB pins the architect assigns itself still count as native USB, so USB wake stays (real system run 2)", () => {
	const s = logger()
	assert.notEqual(usbWake(s), null)
	s.values.pins = [...s.values.pins!, { signal: "USB_DN", gpio: 18, partRef: "J1", partPin: "DN" }, { signal: "USB_DP", gpio: 19, partRef: "J1", partPin: "DP" }]
	assert.notEqual(usbWake(s), null)
	// GPIO18 used for something else: no native USB, no USB wake.
	s.values.pins = s.values.pins.map((p) => (p.gpio === 18 ? { ...p, signal: "OTHER", partRef: "D1", partPin: "A" } : p))
	assert.equal(usbWake(s), null)
})

test("--max-revisions sets the run's revision budget; a system gives its boards 40", async () => {
	const args = parseArgs(["briefs/logger.md", "--max-revisions", "40"])
	assert.ok(!("error" in args) && args.maxRevisions === 40 && args.briefPath === "briefs/logger.md")
	assert.match(String((parseArgs(["briefs/logger.md", "--max-revisions", "x"]) as { error: string }).error), /--max-revisions/)
	const { SYSTEM_BOARD_MAX_REVISIONS } = await import("../src/system/run.ts")
	assert.equal(SYSTEM_BOARD_MAX_REVISIONS, 40)
})

test("a connector on the module's edge is named before any build, so the board isn't grown instead (real system run 4)", () => {
	// The beacon at revision 17: USB-C on the left puts the module on the right, where SW1 sat; the build said only
	// "no room for U1", and the board grew to 64×40 mm.
	const s = logger()
	s.values.connectors = [{ ...s.values.connectors![0], edge: "left", offsetMm: 8 }, { ref: "SW1", kind: "button", edge: "right", offsetMm: 15, widthMm: 5.8, heightMm: 3 }]
	const v = moduleEdgeBlocked(s)
	assert.equal(v.length, 1)
	assert.match(v[0].message, /U1 \(the radio module\) only goes at the right edge, opposite USB-C J1/)
	assert.match(v[0].message, /in the way: SW1 \(right@15 mm\): right@[\d.]+ mm is the nearest spot that clears it/)
	// Moved to the top but kept by the corner (the beacon in system run 5): the message names the offset that clears it.
	s.values.connectors = s.values.connectors.map((k) => (k.ref === "SW1" ? { ...k, edge: "top", offsetMm: 40 } : k))
	const near = moduleEdgeBlocked(s)
	assert.equal(near.length, 1)
	const at = Number(near[0].message.match(/top@([\d.]+) mm is the nearest spot that clears it/)?.[1])
	assert.ok(at < 40, near[0].message)
	s.values.connectors = s.values.connectors.map((k) => (k.ref === "SW1" ? { ...k, offsetMm: at } : k))
	assert.deepEqual(moduleEdgeBlocked(s), [], "the named offset does clear it")
	assert.deepEqual(v[0].affects, ["architect"])
	// The fix the architect should make: SW1 to another edge, same 50×30 mm board.
	s.values.connectors = s.values.connectors.map((k) => (k.ref === "SW1" ? { ...k, edge: "top", offsetMm: 25 } : k))
	assert.deepEqual(moduleEdgeBlocked(s), [])
	assert.deepEqual(moduleEdgeBlocked(logger()), [])
})

// The robot's body goes to each board with its links, and again as built outlines replace the estimates.
const requestsOf = (dir: string) => readFileSync(join(dir, "requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
// A board process that settles at once with the given outline (the system reads trace.jsonl and contract.json).
const fakeStart = (outlines: Record<string, { widthMm: number; heightMm: number }>): typeof startRunProcess => (a) => {
	const name = a.outDir.split("/").at(-1)!
	const c = fixtureContract()
	c.values = { ...c.values, outline: { ...c.values.outline!, ...outlines[name] } }
	writeFileSync(join(a.outDir, "contract.json"), JSON.stringify(c))
	writeFileSync(join(a.outDir, "trace.jsonl"), [{ at: "2026-11-14T10:00:00Z", type: "design.settled", payload: { settled: true } }].map((e) => JSON.stringify(e)).join("\n") + "\n")
	return { done: Promise.resolve({ code: 0, stderr: "", stdout: "" }), kill() {} }
}
const robot = (body: "chassis" | "separate" | null, built: Record<string, { widthMm: number; heightMm: number }> = {}): SystemSpec => {
	const spec: SystemSpec = { name: "bot", boards: [{ name: "main", brief: "m.md" }, { name: "front", brief: "f.md" }], links: [{ id: "L1", kind: "uart", a: { board: "main" }, b: { board: "front" }, cable: { lengthMm: 100 } }] }
	return body ? { ...spec, assembly: defaultAssembly(spec, body, built) } : spec
}

test("a robot's boards get the assembly with their links", async () => {
	const spec = robot("chassis"), out = tempDir()
	await runSystem({ spec, outDir: out, mock: true, pollMs: 10, timeoutMs: 300, start: fakeStart({}) })
	for (const name of ["main", "front"]) {
		const first = requestsOf(join(out, "boards", name))[0]
		assert.equal(first.assembly.self, name)
		assert.ok(first.links.length > 0, "the links are in the same request")
		assert.deepEqual(first.assembly.boards, spec.assembly!.boards)
		assert.deepEqual(first.assembly.plate, spec.assembly!.plate)
	}
})

test("a built outline replaces the estimate and goes back to the robot boards", async () => {
	// main is already built at the size its contract has, so only front's outline is news.
	const spec = robot("chassis", { main: { ...fixtureContract().values.outline! } }), out = tempDir()
	await runSystem({ spec, outDir: out, mock: true, pollMs: 10, timeoutMs: 300, start: fakeStart({ front: { widthMm: 52, heightMm: 31 } }) })
	const written = JSON.parse(readFileSync(join(out, "system.json"), "utf8")).assembly
	const front = written.boards.find((b: { name: string }) => b.name === "front")
	assert.deepEqual(front.outline, { widthMm: 52, heightMm: 31 })
	assert.equal(front.outlineSource, "built")
	const main = requestsOf(join(out, "boards", "main"))
	assert.equal(main.length, 2)
	assert.deepEqual(main[1].assembly.boards.find((b: { name: string }) => b.name === "front").outline, { widthMm: 52, heightMm: 31 })
	assert.equal(main[1].assembly.self, "main")
})

test("with the rounds used up, a changed body isn't called settled: it is written, and the stale boards are named", async () => {
	const spec = robot("chassis", { main: { ...fixtureContract().values.outline! } }), out = tempDir()
	const r = await runSystem({ spec, outDir: out, mock: true, pollMs: 10, timeoutMs: 3000, maxRounds: 0, start: fakeStart({ front: { widthMm: 52, heightMm: 31 } }) })
	assert.equal(r.ok, false)
	const status: string = JSON.parse(readFileSync(join(out, "system-state.json"), "utf8")).status
	assert.match(status, /^UNSETTLED: the robot's body changed after 0 rounds and was not sent to .*main/)
	assert.equal(requestsOf(join(out, "boards", "main")).length, 1, "nothing was sent")
	const front = JSON.parse(readFileSync(join(out, "system.json"), "utf8")).assembly.boards.find((b: { name: string }) => b.name === "front")
	assert.deepEqual(front.outline, { widthMm: 52, heightMm: 31 })
})

test("a board that ended unsettled doesn't keep a settled sibling's outline an estimate in the written assembly", async () => {
	const spec = robot("chassis", { main: { ...fixtureContract().values.outline! } }), out = tempDir()
	const start: typeof startRunProcess = (a) => {
		const r = fakeStart({ front: { widthMm: 52, heightMm: 31 } })(a)
		if (a.outDir.endsWith("/main")) writeFileSync(join(a.outDir, "trace.jsonl"), JSON.stringify({ at: "2026-11-14T10:00:00Z", type: "design.settled", payload: { settled: false } }) + "\n")
		// front settles a little after main ended unsettled: the run waits for it.
		if (a.outDir.endsWith("/front")) { const t = readFileSync(join(a.outDir, "trace.jsonl")); writeFileSync(join(a.outDir, "trace.jsonl"), ""); setTimeout(() => writeFileSync(join(a.outDir, "trace.jsonl"), t), 80) }
		return r
	}
	const r = await runSystem({ spec, outDir: out, mock: true, pollMs: 10, timeoutMs: 3000, start })
	assert.equal(r.ok, false)
	assert.match(JSON.parse(readFileSync(join(out, "system-state.json"), "utf8")).status, /^UNSETTLED: main ended unsettled/)
	const front = JSON.parse(readFileSync(join(out, "system.json"), "utf8")).assembly.boards.find((b: { name: string }) => b.name === "front")
	assert.deepEqual([front.outline, front.outlineSource], [{ widthMm: 52, heightMm: 31 }, "built"])
})

test("a board is not sent the assembly again when only its own outline changed", async () => {
	// front's own outline (same width, so the plate stays) is its own truth; main has nothing new either.
	const spec = robot("chassis", { main: { ...fixtureContract().values.outline! } }), out = tempDir()
	await runSystem({ spec, outDir: out, mock: true, pollMs: 10, timeoutMs: 300, start: fakeStart({ front: { widthMm: 40, heightMm: 31 } }) })
	assert.equal(requestsOf(join(out, "boards", "front")).length, 1)
	assert.equal(requestsOf(join(out, "boards", "main")).length, 2, "main's sibling front changed")
})

test("the run waits for a board that was sent the assembly again to settle before it ends", async () => {
	const spec = robot("chassis", { main: { ...fixtureContract().values.outline! } }), out = tempDir()
	const timers: NodeJS.Timeout[] = []
	// The fake settles once at start; `main` settles a second time only after its second (assembly) request arrived.
	const start: typeof startRunProcess = (a) => {
		const name = a.outDir.split("/").at(-1)!
		const base = fakeStart(name === "front" ? { front: { widthMm: 40, heightMm: 31 } } : {})(a)
		if (name === "main") {
			const t = setInterval(() => {
				if (requestsOf(a.outDir).length >= 2) {
					appendFileSync(join(a.outDir, "trace.jsonl"), JSON.stringify({ at: "2026-11-14T10:01:00Z", type: "design.settled", payload: { settled: true } }) + "\n")
					clearInterval(t)
				}
			}, 20)
			timers.push(t)
		}
		return base
	}
	const r = await runSystem({ spec, outDir: out, mock: true, pollMs: 10, timeoutMs: 3000, start })
	timers.forEach(clearInterval)
	const settles = readFileSync(join(out, "boards", "main", "trace.jsonl"), "utf8").trim().split("\n").filter((l) => JSON.parse(l).type === "design.settled").length
	assert.equal(settles, 2, "the run ended before main settled on the new assembly")
	assert.ok(!/timed out/.test(JSON.parse(readFileSync(join(out, "system-state.json"), "utf8")).status), "it ended on its checks, not on the clock")
})

test("a design that isn't a robot gets no assembly request", async () => {
	for (const body of ["separate", null] as const) {
		const out = tempDir()
		await runSystem({ spec: robot(body), outDir: out, mock: true, pollMs: 10, timeoutMs: 300, start: fakeStart({ front: { widthMm: 52, heightMm: 31 } }) })
		for (const name of ["main", "front"]) {
			const reqs = requestsOf(join(out, "boards", name))
			assert.equal(reqs.length, 1, "only the links request, as today")
			assert.ok(reqs.every((r) => !("assembly" in r)))
		}
	}
})

test("boards that can't fit the brief's size limit end the run with a finding that names it", async () => {
	const out = tempDir()
	const limited: typeof startRunProcess = (a) => {
		const r = fakeStart({ main: { widthMm: 43, heightMm: 30 }, front: { widthMm: 200, heightMm: 30 } })(a)
		const path = join(a.outDir, "contract.json")
		const c = JSON.parse(readFileSync(path, "utf8"))
		c.values.motion = { ...ROVER_MOTION, maxSizeMm: [160, 150] }
		writeFileSync(path, JSON.stringify(c))
		return r
	}
	const res = await runSystem({ spec: robot("chassis"), outDir: out, mock: true, pollMs: 10, timeoutMs: 2000, start: limited })
	assert.equal(res.ok, false)
	const state = JSON.parse(readFileSync(join(out, "system-state.json"), "utf8"))
	assert.match(state.status, /^UNSETTLED: assembly: the boards need a \d+ × \d+ mm plate, over the 160 × 150 mm plate the brief's size allows/)
	assert.equal(state.findings[0].kind, "assembly-fit")
})
