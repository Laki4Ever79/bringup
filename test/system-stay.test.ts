import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { startRunProcess } from "../src/runner/spawn-run.ts"
import type { SystemSpec } from "../src/system/spec.ts"
import { runSystem, SYSTEM_REQUESTS } from "../src/system/run.ts"
import { readSystemTrace, stepOf } from "../src/system/trace.ts"
import { defaultAssembly } from "../src/system/assembly.ts"
import { fixtureContract } from "./fixture.ts"
import { tempDir, waitFor } from "./helpers.ts"

const requestsOf = (dir: string) => (existsSync(join(dir, "requests.jsonl")) ? readFileSync(join(dir, "requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [])

// A board process that builds and settles, and settles again after each new request (as a real --stay board does).
const settlingBoards = (timers: NodeJS.Timeout[]): typeof startRunProcess => (a) => {
	const c = fixtureContract()
	writeFileSync(join(a.outDir, "contract.json"), JSON.stringify(c))
	const line = (type: string, payload: unknown) => appendFileSync(join(a.outDir, "trace.jsonl"), JSON.stringify({ at: new Date().toISOString(), type, payload }) + "\n")
	let revision = 1
	const settle = () => {
		line("artifact.ready", { kind: "board", revision, drc: { errors: 0 } })
		line("artifact.ready", { kind: "firmware", revision })
		line("design.settled", { revision, settled: true })
	}
	settle()
	let seen = requestsOf(a.outDir).length
	timers.push(
		setInterval(() => {
			const n = requestsOf(a.outDir).length
			if (n > seen) {
				seen = n
				revision++
				settle()
			}
		}, 15),
	)
	return { done: Promise.resolve({ code: 0, stderr: "", stdout: "" }), kill() {} }
}

const robot = (): SystemSpec => {
	const spec: SystemSpec = { name: "bot", boards: [{ name: "main", brief: "m.md" }, { name: "front", brief: "f.md" }], links: [{ id: "L1", kind: "uart", a: { board: "main" }, b: { board: "front" }, cable: { lengthMm: 100 } }] }
	const o = fixtureContract().values.outline!
	return { ...spec, assembly: defaultAssembly(spec, "chassis", { main: { ...o }, front: { ...o } }) }
}

test("each board's steps reach the system trace, with the system's own settle", async () => {
	const out = tempDir(), timers: NodeJS.Timeout[] = []
	try {
		await runSystem({ spec: robot(), outDir: out, mock: true, pollMs: 10, timeoutMs: 2000, start: settlingBoards(timers) })
	} finally {
		timers.forEach(clearInterval)
	}
	const lines = readSystemTrace(out)
	for (const board of ["main", "front"]) {
		assert.ok(lines.some((l) => l.board === board && l.step === "board" && l.status === "ok"), `${board} board`)
		assert.ok(lines.some((l) => l.board === board && l.step === "settled" && l.status === "ok"), `${board} settled`)
	}
	// The fixture boards have no link pins, so the system stops on its findings: its settle line says so, as the state does.
	const sys = lines.filter((l) => l.board === "system" && l.step === "settled")
	const state = JSON.parse(readFileSync(join(out, "system-state.json"), "utf8"))
	assert.equal(sys.length, 1)
	assert.equal(sys[0].status, state.settled ? "ok" : "failed")
	assert.equal(sys[0].detail, state.status)
	assert.ok(lines.every((l) => typeof l.round === "number" && typeof l.at === "string"))
	assert.equal(readSystemTrace(out, lines.length - 1).length, 1, "a reader can start from where it left off")
})

test("a board step's status: DRC errors and a failed or skipped drive are not ok", () => {
	assert.equal(stepOf({ type: "artifact.ready", payload: { kind: "board", revision: 3, drc: { errors: 2, firstError: "clearance" } } })?.status, "failed")
	assert.equal(stepOf({ type: "artifact.ready", payload: { kind: "drive", revision: 3, drive: { result: "fail", failed: "edge crossed" } } })?.detail, "failed at edge crossed")
	assert.deepEqual(stepOf({ type: "artifact.ready", payload: { kind: "drive", revision: 3, drive: { result: "not run", reason: "pins not assigned yet" } } }), { step: "drive", status: "not run", revision: 3, detail: "pins not assigned yet" })
	assert.equal(stepOf({ type: "artifact.ready", payload: { kind: "enclosure", revision: 3, skipped: "no case" } })?.status, "not run")
	assert.equal(stepOf({ type: "artifact.failed", payload: { kind: "chassis", revision: 3, error: "boom\nmore" } })?.detail, "boom")
	assert.equal(stepOf({ type: "agent.activity", payload: {} }), null)
})

test("--stay: a system-level request moves a board; every board gets the new body and the system settles again", async () => {
	const out = tempDir(), timers: NodeJS.Timeout[] = []
	let stop!: () => void
	const until = new Promise<void>((r) => (stop = r))
	const spec = robot()
	const run = runSystem({ spec, outDir: out, mock: true, pollMs: 10, timeoutMs: 3000, start: settlingBoards(timers), stay: { until } })
	try {
		await waitFor(() => readSystemTrace(out).some((l) => l.board === "system" && l.step === "settled"), 3000)
		const before = { main: requestsOf(join(out, "boards", "main")).length, front: requestsOf(join(out, "boards", "front")).length }
		const moved = spec.assembly!.boards.map((b) => (b.name === "front" ? { ...b, xMm: b.xMm + 5 } : b))
		appendFileSync(join(out, SYSTEM_REQUESTS), JSON.stringify({ at: new Date().toISOString(), text: "move front 5 mm forward", assembly: { boards: moved } }) + "\n")
		await waitFor(() => readSystemTrace(out).filter((l) => l.board === "system" && l.step === "settled").length >= 2, 3000)
		for (const name of ["main", "front"] as const) {
			const reqs = requestsOf(join(out, "boards", name))
			assert.equal(reqs.length, before[name] + 1, name)
			assert.equal(reqs.at(-1).assembly.boards.find((b: { name: string }) => b.name === "front").xMm, moved.find((b) => b.name === "front")!.xMm)
			assert.match(reqs.at(-1).text, /move front 5 mm forward/)
		}
		const written = JSON.parse(readFileSync(join(out, "system.json"), "utf8"))
		assert.equal(written.assembly.boards.find((b: { name: string }) => b.name === "front").xMm, moved.find((b) => b.name === "front")!.xMm)
		const lines = readSystemTrace(out)
		assert.ok(lines.some((l) => l.step === "request" && l.board === "front" && l.round >= 1))
		assert.ok(lines.findIndex((l) => l.step === "request" && l.board === "front") < lines.findLastIndex((l) => l.board === "system" && l.step === "settled"), "the system settled again after the request")
	} finally {
		stop()
		await run
		timers.forEach(clearInterval)
	}
})

// A board edited on its own page settles again by itself: the system checks again (cable, chassis, links).
test("--stay: a board that settles again after its own edit makes the system check again", async () => {
	const out = tempDir(), timers: NodeJS.Timeout[] = []
	let stop!: () => void
	const until = new Promise<void>((r) => (stop = r))
	const run = runSystem({ spec: robot(), outDir: out, mock: true, pollMs: 10, timeoutMs: 3000, start: settlingBoards(timers), stay: { until } })
	try {
		const sysSettles = () => readSystemTrace(out).filter((l) => l.board === "system" && l.step === "settled").length
		await waitFor(() => sysSettles() >= 1, 3000)
		// The board page's change request goes to the board alone (as POST /api/runs/<board>/requests does).
		appendFileSync(join(out, "boards", "front", "requests.jsonl"), JSON.stringify({ at: new Date().toISOString(), text: "turn U5 90°" }) + "\n")
		await waitFor(() => sysSettles() >= 2, 3000)
		assert.ok(readSystemTrace(out).some((l) => l.board === "system" && l.step === "request" && /front changed on its own page/.test(l.detail ?? "")))
	} finally {
		stop()
		await run
		timers.forEach(clearInterval)
	}
})
