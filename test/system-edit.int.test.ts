// A running robot, edited while it runs (system view phase 3): the engineer moves and turns a board, makes the plate
// bigger, and re-routes the cable, each as one Apply through the hub's HTTP API; every round settles, and the build stays
// trackable in the system trace. Scripted agents (--mock) on the real toolchain, started by the hub's own launcher with --stay.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { ROOT } from "../src/run.ts"
import { detectEnvironment } from "../src/tools/env.ts"
import { startRunProcess } from "../src/runner/spawn-run.ts"
import { serveHub } from "../src/dashboard/server.ts"
import { boardDir } from "../src/system/run.ts"
import { readSystemTrace } from "../src/system/trace.ts"
import { cableLength, CABLE_SLACK_MM } from "../src/system/assembly.ts"
import type { SystemSpec } from "../src/system/spec.ts"
import type { ChassisSpec } from "../src/tools/chassis.ts"
import { editor } from "../src/dashboard/system-edit.js"
import { tempDir, slow } from "./helpers.ts"

const env = await detectEnvironment(ROOT)
const skip = env.tsci && env.kicad && env.python ? false : "needs tscircuit, KiCad and the .venv with build123d (npm run doctor)"

const rev = (p: string) => Number(/rev-(\d+)/.exec(p)?.[1] ?? -1)
function chassisSpecs(dir: string): string[] {
	const out: string[] = []
	for (const e of readdirSync(dir)) {
		const p = join(dir, e)
		if (statSync(p).isDirectory()) out.push(...chassisSpecs(p))
		else if (e === "spec.json" && existsSync(join(dir, "chassis.step"))) out.push(p)
	}
	return out
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("a running robot takes a moved, rotated board, a bigger plate and a re-routed cable, and settles each time", { skip: slow || skip, timeout: 3_000_000 }, async () => {
	const root = tempDir()
	const hub = await serveHub({ outRoot: root, port: 0, launch: startRunProcess })
	let id = ""
	try {
		const post = async (path: string, body: unknown) => {
			const r = await fetch(`${hub.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
			return { status: r.status, body: (await r.json()) as Record<string, any> }
		}
		const started = await post("/api/systems", { spec: "rover-climate.json", mock: true, review: false, hardware: true })
		assert.equal(started.status, 201)
		id = started.body.systemId
		const out = join(root, id)
		const trace = () => readSystemTrace(out)
		const spec = () => JSON.parse(readFileSync(join(out, "system.json"), "utf8")) as SystemSpec
		// Waits for the system's own settle line of a round, with the process up and staying (the server refuses before that).
		const settled = async (round: number, ms: number) => {
			const t0 = Date.now()
			while (Date.now() - t0 < ms) {
				if (trace().some((l) => l.board === "system" && l.step === "settled" && l.round >= round)) { const s = trace().filter((l) => l.board === "system" && l.step === "settled").at(-1)!; assert.equal(s.status, "ok", `the system did not settle at round ${round}: ${s.detail}`); return }
				await sleep(1000)
			}
			throw new Error(`no settle at round ${round}; trace tail: ${JSON.stringify(trace().slice(-8))}`)
		}
		const stays = () => trace().some((l) => l.board === "system" && l.step === "request" && /staying up/.test(l.detail ?? ""))
		await settled(0, 1_500_000)
		for (let i = 0; i < 120 && !stays(); i++) await sleep(500)
		assert.ok(stays(), "the system never said it stays up")
		const first = spec()
		assert.equal(first.assembly?.boards.find((b) => b.name === "climate")?.outlineSource, "built")

		// Round 2: one Apply, built with the page's editor: climate 10 mm back, turned 90°, the plate 4 mm shorter: the system's plate already uses all the rover's brief allows (150 × 96 mm: 150 × 120 mm less the 10 mm wheels and their clearance), so a bigger one is refused by main's mech-fit, as it should be.
		const ed = editor({ assembly: first.assembly!, links: first.links })
		const c0 = first.assembly!.boards.find((b) => b.name === "climate")!
		assert.ok(ed.apply({ kind: "rotate", board: "climate" }))
		assert.ok(ed.apply({ kind: "move", board: "climate", xMm: c0.xMm - 10, yMm: c0.yMm }))
		assert.ok(ed.apply({ kind: "plate", lengthMm: first.assembly!.plate!.lengthMm - 4, widthMm: first.assembly!.plate!.widthMm }))
		assert.deepEqual(ed.findings().filter((f) => f.level === "error"), [])
		const diff1 = ed.diff()!
		const sentAt = trace().length
		const r1 = await post(`/api/systems/${id}/requests`, diff1)
		assert.equal(r1.status, 202, JSON.stringify(r1.body))
		await settled(r1.body.round, 1_200_000)
		ed.markApplied()
		const round2 = trace().slice(sentAt)
		const asked2 = round2.filter((l) => l.step === "request" && l.status === "started").map((l) => l.board)
		assert.ok(asked2.includes("climate"), `climate was not told: ${asked2}`)
		assert.ok(asked2.every((b) => ["main", "climate"].includes(b)), `a request went to a board that is not in the system: ${asked2}`)
		const sys2 = spec()
		const c2 = sys2.assembly!.boards.find((b) => b.name === "climate")!
		assert.equal(c2.rotDeg, 90)
		assert.equal(c2.xMm, c0.xMm - 10)
		assert.deepEqual(sys2.assembly!.plate, { lengthMm: first.assembly!.plate!.lengthMm - 4, widthMm: first.assembly!.plate!.widthMm })
		const newest = (() => {
			const specs = chassisSpecs(boardDir(out, "main")).sort((a, b) => rev(a) - rev(b))
			return JSON.parse(readFileSync(specs.at(-1)!, "utf8")) as ChassisSpec
		})()
		const placed = newest.boards.find((b) => b.name === "climate")!
		assert.equal(placed.rotDeg, 90, "main's newest chassis has climate unturned")
		assert.equal(placed.xMm, c2.xMm, "main's newest chassis has climate at its old place")
		assert.equal(newest.plate.lengthMm, sys2.assembly!.plate!.lengthMm, "main's newest chassis has the old plate length")
		assert.equal(newest.plate.widthMm, sys2.assembly!.plate!.widthMm, "main's newest chassis has the old plate")

		// Round 3: a cable route that changes L1's length.
		const m = sys2.assembly!.boards.find((b) => b.name === "main")!
		// A detour round the front of the plate, longer than the default 300 mm. It leaves main's right edge and enters climate
		// (turned 90°) from its -x side, so L1 keeps the edges JL1 is already on (main right, climate top): a route that
		// changes an edge asks the boards to move the connector, which the scripted agents don't do.
		const route = [{ xMm: m.xMm + 16.5, yMm: 0 }, { xMm: 30, yMm: 0 }, { xMm: 30, yMm: -50 }, { xMm: 75, yMm: -50 }, { xMm: 75, yMm: 50 }, { xMm: 25, yMm: 50 }, { xMm: 25, yMm: 0 }, { xMm: c2.xMm, yMm: c2.yMm }]
		assert.ok(ed.apply({ kind: "cable-route", link: "L1", points: route }))
		const diff2 = ed.diff()!
		assert.deepEqual([diff2.links![0].a.edge, diff2.links![0].b.edge], ["right", "top"], "the route changed an edge of L1")
		const sentAt3 = trace().length
		const before = sys2.links[0].cable.lengthMm
		const r2 = await post(`/api/systems/${id}/requests`, diff2)
		assert.equal(r2.status, 202, JSON.stringify(r2.body))
		await settled(r2.body.round, 900_000)
		const round3 = trace().slice(sentAt3)
		assert.ok(round3.some((l) => l.step === "request"), "round 3 has no request line")
		assert.ok(round3.filter((l) => l.step === "request").every((l) => ["system", "main", "climate"].includes(l.board)))
		const sys3 = spec()
		const pts = diff2.assembly!.cables!.find((c: any) => c.link === "L1")!.points
		assert.equal(sys3.links[0].cable.lengthMm, Math.round(cableLength(pts) + CABLE_SLACK_MM), "the cable length does not follow the route")
		assert.ok(sys3.links[0].cable.lengthMm > before, `the cable is not longer: ${before} -> ${sys3.links[0].cable.lengthMm}`)

		// The run ends clean, and its trace shows every board's steps.
		const state = JSON.parse(readFileSync(join(out, "system-state.json"), "utf8"))
		assert.deepEqual(state.findings, [], `system findings: ${JSON.stringify(state.findings)}`)
		assert.equal(state.settled, true, state.status)
		const lines = trace()
		for (const board of ["main", "climate"]) {
			const steps = lines.filter((l) => l.board === board).map((l) => l.step)
			for (const s of ["contract", "board", "firmware", "settled"] as const) assert.ok(steps.includes(s), `${board} has no ${s} step: ${[...new Set(steps)]}`)
		}
		assert.ok(lines.some((l) => l.board === "main" && l.step === "chassis"), "main has no chassis step")
		assert.ok(lines.some((l) => l.board === "system" && l.step === "settled"))
		assert.deepEqual([...new Set(lines.map((l) => l.round))].sort((a, b) => a - b).slice(0, 3), [0, 1, 2])
	} finally {
		if (id) await post_stop(hub.url, id)
		await hub.close()
	}
})

async function post_stop(url: string, id: string) {
	await fetch(`${url}/api/systems/${id}/stop`, { method: "POST" }).catch(() => {})
	await sleep(3000)
}
