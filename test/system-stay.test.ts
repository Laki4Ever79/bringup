import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { startRunProcess } from "../src/runner/spawn-run.ts"
import type { SystemSpec } from "../src/system/spec.ts"
import { runSystem, SYSTEM_REQUESTS } from "../src/system/run.ts"
import { readSystemTrace, stepOf } from "../src/system/trace.ts"
import { CABLE_SLACK_MM, cableLength, defaultAssembly } from "../src/system/assembly.ts"
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
		await waitFor(() => readSystemTrace(out).some((l) => l.board === "system" && l.step === "settled"))
		const before = { main: requestsOf(join(out, "boards", "main")).length, front: requestsOf(join(out, "boards", "front")).length }
		const moved = spec.assembly!.boards.map((b) => (b.name === "front" ? { ...b, xMm: b.xMm + 5 } : b))
		appendFileSync(join(out, SYSTEM_REQUESTS), JSON.stringify({ at: new Date().toISOString(), text: "move front 5 mm forward", assembly: { boards: moved } }) + "\n")
		await waitFor(() => readSystemTrace(out).filter((l) => l.board === "system" && l.step === "settled").length >= 2)
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
		await waitFor(() => sysSettles() >= 1)
		// The board page's change request goes to the board alone (as POST /api/runs/<board>/requests does).
		appendFileSync(join(out, "boards", "front", "requests.jsonl"), JSON.stringify({ at: new Date().toISOString(), text: "turn U5 90°" }) + "\n")
		await waitFor(() => sysSettles() >= 2)
		assert.ok(readSystemTrace(out).some((l) => l.board === "system" && l.step === "request" && /front changed on its own page/.test(l.detail ?? "")))
	} finally {
		stop()
		await run
		timers.forEach(clearInterval)
	}
})

// Drives a --stay run, sends one request line, waits for the system's next settle (or, for a request touching nothing,
// for its "no board's view changed" line), and returns how many requests each board got.
async function stayRequest(spec: SystemSpec, request: object, settleAgain = false) {
	const out = tempDir(), timers: NodeJS.Timeout[] = []
	let stop!: () => void
	const until = new Promise<void>((r) => (stop = r))
	const run = runSystem({ spec, outDir: out, mock: true, pollMs: 10, timeoutMs: 3000, start: settlingBoards(timers), stay: { until } })
	try {
		await waitFor(() => readSystemTrace(out).some((l) => l.board === "system" && l.step === "settled"))
		const count = (n: string) => requestsOf(join(out, "boards", n)).length
		const before = Object.fromEntries(spec.boards.map((b) => [b.name, count(b.name)]))
		appendFileSync(join(out, SYSTEM_REQUESTS), JSON.stringify({ at: new Date().toISOString(), ...request }) + "\n")
		if (settleAgain) await waitFor(() => readSystemTrace(out).filter((l) => l.board === "system" && l.step === "settled").length >= 2)
		else await waitFor(() => readSystemTrace(out).some((l) => l.step === "request" && l.round >= 1 && (l.status === "started" || /no board/.test(l.detail ?? ""))))
		await new Promise((r) => setTimeout(r, 200))
		const gained = Object.fromEntries(spec.boards.map((b) => [b.name, count(b.name) - before[b.name]]))
		return { out, gained, system: JSON.parse(readFileSync(join(out, "system.json"), "utf8")) as SystemSpec }
	} finally {
		stop()
		await run
		timers.forEach(clearInterval)
	}
}

test("--stay: moving one board of two touches both (each is the other's sibling), and the chassis rewrites system.json", async () => {
	const spec = robot()
	const moved = spec.assembly!.boards.map((b) => (b.name === "front" ? { ...b, yMm: b.yMm + 3 } : b))
	const { gained } = await stayRequest(spec, { assembly: { boards: moved } })
	assert.deepEqual(gained, { main: 1, front: 1 })
})

test("--stay: only the boards whose view changed are re-sent (a request that changes nothing touches none)", async () => {
	const spec = robot()
	const same = await stayRequest(spec, { assembly: { boards: spec.assembly!.boards } })
	assert.deepEqual(same.gained, { main: 0, front: 0 })
	// A plate change on a system whose body is separate has no chassis to carry: nothing is re-sent.
	const separate: SystemSpec = { ...spec, assembly: { ...spec.assembly!, body: "separate" } }
	const sep = await stayRequest(separate, { assembly: { plate: { lengthMm: 200, widthMm: 150 } } })
	assert.deepEqual(sep.gained, { main: 0, front: 0 })
	// A link change reaches both ends of that link only through the boards whose links changed.
	const l = spec.links[0]
	const links = await stayRequest(spec, { links: [{ ...l, baud: 9600 }] })
	assert.deepEqual(links.gained, { main: 1, front: 1 })
})

test("--stay: a cable route survives the merge and sets the link's cable length plus slack", async () => {
	const spec = robot()
	const cables = [{ link: "L1", points: [{ xMm: 0, yMm: 0 }, { xMm: 30, yMm: 0 }, { xMm: 30, yMm: 40 }] }]
	assert.equal(cableLength(cables[0].points), 70)
	const { system } = await stayRequest(spec, { assembly: { cables } })
	assert.deepEqual(system.assembly!.cables, cables)
	assert.equal(system.links[0].cable.lengthMm, 70 + CABLE_SLACK_MM)
	assert.equal(system.assembly!.boards.length, 2, "boards and plate are kept")
})

test("--stay: a cable-length-only change makes the system check again with no board request, saying why", async () => {
	const spec = robot()
	const l = spec.links[0]
	const r = await stayRequest(spec, { links: [{ ...l, cable: { lengthMm: 340 } }] }, true)
	assert.deepEqual(r.gained, { main: 0, front: 0 })
	const lines = readSystemTrace(r.out)
	assert.ok(lines.some((x) => x.board === "system" && x.step === "request" && /cable L1 is now 340 mm; checking the system again/.test(x.detail ?? "")))
	assert.equal(lines.filter((x) => x.board === "system" && x.step === "settled").length, 2, "a new settled line")
	assert.equal(r.system.links[0].cable.lengthMm, 340)
})

test("--stay: moving a cable route alone re-sends nothing to the boards", async () => {
	const spec = robot()
	const cables = [{ link: "L1", points: [{ xMm: 0, yMm: 0 }, { xMm: 30, yMm: 0 }] }]
	assert.deepEqual((await stayRequest(spec, { assembly: { cables } }, true)).gained, { main: 0, front: 0 })
})
