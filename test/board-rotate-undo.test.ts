// The board page, step 3 continued (14 Nov 2026, "finish the board page"): turn a placed part in 90° steps, and take
// back a batch already sent. A turned part's pin capacitors turn with it (they must stay beside their pads: the
// DRV8833's VINT and VCP have 5 mm of trace); undo sends the opposite moves, and a part the layout had placed goes back
// to the layout's choice instead of being pinned where it happened to be.
import { test } from "node:test"
import assert from "node:assert/strict"
import { circuitFromContract, icPinOffset, layoutBoard } from "../src/codegen/circuit.ts"
import { checkMoves, moveRequest, movables, parseMoves, undoMoves, applyMoves } from "../src/dashboard/board-move.ts"
import { LOGGER_DESIGN, ROVER_BOARD } from "../src/inference/scripts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { fixtureContract } from "./fixture.ts"

const logger = (): ContractSnapshot => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	return s
}
const rover = (): ContractSnapshot => ({ revision: 20, versions: {} as never, values: structuredClone(ROVER_BOARD) as ContractSnapshot["values"] })

test("a part turned on the board page is placed at that rotation, in the board file too", () => {
	const s = applyMoves(logger(), [{ ref: "U2", xMm: 30, yMm: 6, rotationDeg: 90 }])
	assert.deepEqual(s.values.parts!.find((p) => p.ref === "U2")!.at, { xMm: 30, yMm: 6, rotationDeg: 90 })
	assert.equal(layoutBoard(s).parts.find((p) => p.ref === "U2")!.rotation, 90)
	assert.match(circuitFromContract(s), /name="U2"[^\n]*pcbRotation=\{90\}/)
})

test("a turned motor driver's pin capacitors turn with it: each stays just past its own pad", () => {
	const s = rover()
	const W = s.values.outline!.widthMm, H = s.values.outline!.heightMm
	const u5 = layoutBoard(s).parts.find((p) => p.ref === "U5")!
	for (const rotationDeg of [90, 180, 270] as const) {
		const t = applyMoves(s, [{ ref: "U5", xMm: u5.x + W / 2, yMm: u5.y + H / 2, rotationDeg }])
		const r = checkMoves(s, [{ ref: "U5", xMm: u5.x + W / 2, yMm: u5.y + H / 2, rotationDeg }])
		const placed = layoutBoard(t).parts
		const drv = placed.find((p) => p.ref === "U5")
		if (!drv) {
			// It may not fit turned on a compact board: then the check must say so, not quietly drop it.
			assert.equal(r.ok, false, `U5 at ${rotationDeg}° unplaced but the check passed`)
			continue
		}
		assert.equal(drv.rotation, rotationDeg)
		const fp = ROVER_BOARD.parts.find((p) => p.ref === "U5")!.footprint
		const pins = ROVER_BOARD.parts.find((p) => p.ref === "U5")!.pins
		const th = (rotationDeg * Math.PI) / 180
		for (const [pin, near] of [["VINT", "VINT"], ["VCP", "VCP"]] as const) {
			const at = icPinOffset(fp, pins.indexOf(pin) + 1)!
			const pad = { x: drv.x + at.x * Math.cos(th) - at.y * Math.sin(th), y: drv.y + at.x * Math.sin(th) + at.y * Math.cos(th) }
			const caps = placed.filter((p) => p.ref.startsWith("C"))
			const d = Math.min(...caps.map((c) => Math.hypot(c.x - pad.x, c.y - pad.y)))
			assert.ok(d <= 3.5, `${near}'s capacitor ${d.toFixed(2)} mm from its pad at ${rotationDeg}°`)
		}
	}
})

test("a turn rides in the request and back out of it; the old form still reads", () => {
	const s = logger()
	const text = moveRequest(s, [{ ref: "U2", xMm: 30, yMm: 6, rotationDeg: 270 }])
	assert.match(text, /U2 \(25, 27\) → \(30, 6\) mm turned 270°/)
	assert.deepEqual(parseMoves(text), [{ ref: "U2", xMm: 30, yMm: 6, rotationDeg: 270 }])
	assert.deepEqual(parseMoves(moveRequest(s, [{ ref: "U2", xMm: 30, yMm: 6 }])), [{ ref: "U2", xMm: 30, yMm: 6 }])
	const u2 = movables(s).movable.U2
	assert.equal(u2.kind === "part" ? u2.rotationDeg : -1, 0)
})

test("undo of a sent batch: a part the layout had placed goes back to the layout's choice, a placed one to its spot, a connector to its edge", () => {
	const before = logger()
	before.values.parts = before.values.parts!.map((p) => (p.ref === "R5" ? { ...p, at: { xMm: 40, yMm: 20 } } : p))
	const sent = [{ ref: "U2", xMm: 30, yMm: 6, rotationDeg: 90 as const }, { ref: "R5", xMm: 42, yMm: 20 }, { ref: "J1", edge: "left" as const, offsetMm: 10 }]
	const after = applyMoves(before, sent)
	const back = undoMoves(before, sent)
	assert.deepEqual(back, [{ ref: "U2", release: true }, { ref: "R5", xMm: 40, yMm: 20 }, { ref: "J1", edge: "left", offsetMm: 15 }])
	const undone = applyMoves(after, back)
	assert.equal(undone.values.parts!.find((p) => p.ref === "U2")!.at, undefined)
	assert.deepEqual(undone.values.parts!.find((p) => p.ref === "R5")!.at, { xMm: 40, yMm: 20 })
	assert.equal(undone.values.connectors!.find((c) => c.ref === "J1")!.offsetMm, 15)
	// The release rides in the request too, and is checked like any move.
	const text = moveRequest(after, back)
	assert.match(text, /U2 \(30, 6\) → the layout's choice/)
	assert.deepEqual(parseMoves(text), back)
	assert.equal(checkMoves(after, back).ok, true, JSON.stringify(checkMoves(after, back).problems))
})

test("a scripted logger run takes a turn, then its undo: U2 turned 90° where it was put, then back to the layout's choice", { timeout: 600_000 }, async () => {
	const { readFileSync } = await import("node:fs")
	const { join } = await import("node:path")
	const { runDesign } = await import("../src/run.ts")
	const { tempDir } = await import("./helpers.ts")
	const brief = readFileSync("briefs/logger.md", "utf8")
	const run = async (changes: string[]) => {
		const out = tempDir()
		const r = await runDesign({ brief, mock: true, noHardware: true, review: false, outDir: out, changes, changeTimeoutMs: 30_000 })
		assert.equal(r.settled, true, JSON.stringify(r.violations))
		assert.deepEqual(r.violations, [])
		return JSON.parse(readFileSync(join(out, "contract.json"), "utf8")) as ContractSnapshot
	}
	// As on the page: the settled board, a spot the move check accepts, then the turn and its undo against that board.
	const c0 = await run([])
	const W = c0.values.outline!.widthMm, H = c0.values.outline!.heightMm
	let turn: { ref: string; xMm: number; yMm: number; rotationDeg: 90 } | undefined
	for (let x = 4; x < W && !turn; x += 2) for (let y = 4; y < H && !turn; y += 2) if (checkMoves(c0, [{ ref: "U2", xMm: x, yMm: y, rotationDeg: 90 }]).ok) turn = { ref: "U2", xMm: x, yMm: y, rotationDeg: 90 }
	assert.ok(turn, "no spot on the settled board takes U2 turned")
	const c1 = await run([moveRequest(c0, [turn])])
	assert.deepEqual(c1.values.parts!.find((p) => p.ref === "U2")!.at, { xMm: turn.xMm, yMm: turn.yMm, rotationDeg: 90 })
	assert.equal(layoutBoard(c1).parts.find((p) => p.ref === "U2")!.rotation, 90)
	const c2 = await run([moveRequest(c0, [turn]), moveRequest(c1, undoMoves(c0, [turn]))])
	assert.equal(c2.values.parts!.find((p) => p.ref === "U2")!.at, undefined)
})

test("the board API checks a turn, and an undo worked out from the revision the batch was sent against", async () => {
	const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs")
	const { tmpdir } = await import("node:os")
	const { join } = await import("node:path")
	const { serveDashboard } = await import("../src/dashboard/server.ts")
	const root = mkdtempSync(join(tmpdir(), "undo-hub-"))
	const dir = join(root, "run-1")
	mkdirSync(join(dir, "contracts"), { recursive: true })
	const sent = [{ ref: "U2", xMm: 30, yMm: 6, rotationDeg: 90 as const }]
	writeFileSync(join(dir, "contracts", "rev-1.json"), JSON.stringify({ ...logger(), revision: 1 }))
	writeFileSync(join(dir, "contracts", "rev-2.json"), JSON.stringify({ ...applyMoves(logger(), sent), revision: 2 }))
	writeFileSync(join(dir, "trace.jsonl"), "")
	const dash = await serveDashboard(dir, 0)
	const post = async (body: unknown) => (await (await fetch(`${dash.url}/api/runs/run-1/board/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as { ok: boolean; request: string; problems: unknown[] }
	try {
		const turn = await post({ rev: 1, moves: sent })
		assert.equal(turn.ok, true, JSON.stringify(turn.problems))
		assert.match(turn.request, /U2 \(25, 27\) → \(30, 6\) mm turned 90°/)
		const undo = await post({ rev: 2, undo: { rev: 1, moves: sent } })
		assert.equal(undo.ok, true, JSON.stringify(undo.problems))
		assert.match(undo.request, /U2 \(30, 6\) → the layout's choice/)
		assert.equal((await post({ rev: 1, moves: [{ ref: "U2", xMm: 30, yMm: 6, rotationDeg: 45 }] })).ok, false)
	} finally {
		await dash.close()
		rmSync(root, { recursive: true, force: true })
	}
})

// A capacitor between two pads of the same part (the DRV8833's VCP to VM) faces its pins in the pads' order: turned 90°,
// C7's pin 1 sat toward VM and pin 2 toward VCP, the two traces crossed, and tscircuit routed VCP's 10 mm round
// (past its 5 mm bound; a real build, 14 Nov 2026). At 270° the order happened to match.
test("a capacitor between two pads of one part never crosses its own traces, at every turn of the part", () => {
	const s = rover()
	const W = s.values.outline!.widthMm, H = s.values.outline!.heightMm
	const u5 = layoutBoard(s).parts.find((p) => p.ref === "U5")!
	const part = ROVER_BOARD.parts.find((p) => p.ref === "U5")!
	const cross = (a: number[], b: number[], c: number[], d: number[]) => {
		const o = (p: number[], q: number[], r: number[]) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]))
		return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0
	}
	for (const rotationDeg of [0, 90, 180, 270] as const) {
		const placed = layoutBoard(applyMoves(s, [{ ref: "U5", xMm: u5.x + W / 2, yMm: u5.y + H / 2, rotationDeg }])).parts
		const drv = placed.find((p) => p.ref === "U5")!
		const th = (rotationDeg * Math.PI) / 180
		const pad = (pin: string) => {
			const at = icPinOffset(part.footprint, part.pins.indexOf(pin) + 1)!
			return [drv.x + at.x * Math.cos(th) - at.y * Math.sin(th), drv.y + at.x * Math.sin(th) + at.y * Math.cos(th)]
		}
		const c7 = placed.find((p) => p.ref === "C7")!
		const t = (c7.rotation * Math.PI) / 180
		const end = (k: number) => [c7.x + k * 0.5 * Math.cos(t), c7.y + k * 0.5 * Math.sin(t)] // pin 1 at -x before the turn
		assert.ok(!cross(end(-1), pad("VCP"), end(1), pad("VM")), `C7's traces cross with U5 turned ${rotationDeg}° (C7 at rotation ${c7.rotation})`)
	}
})

// Its pad end faces the pad: turned 180°, the driver's VINT capacitor sat left of it with pin 1 (the VINT end) outside,
// so VINT's trace went round the capacitor's own GND pin: 10.2 mm against 5 (a real build, 14 Nov 2026).
test("a capacitor on a pad has its pad end toward the pad, at every turn of the part", () => {
	const s = rover()
	const W = s.values.outline!.widthMm, H = s.values.outline!.heightMm
	const u5 = layoutBoard(s).parts.find((p) => p.ref === "U5")!
	const part = ROVER_BOARD.parts.find((p) => p.ref === "U5")!
	for (const rotationDeg of [0, 90, 180, 270] as const) {
		const placed = layoutBoard(applyMoves(s, [{ ref: "U5", xMm: u5.x + W / 2, yMm: u5.y + H / 2, rotationDeg }])).parts
		const drv = placed.find((p) => p.ref === "U5")!
		const th = (rotationDeg * Math.PI) / 180
		const at = icPinOffset(part.footprint, part.pins.indexOf("VINT") + 1)!
		const pad = [drv.x + at.x * Math.cos(th) - at.y * Math.sin(th), drv.y + at.x * Math.sin(th) + at.y * Math.cos(th)]
		const c6 = placed.find((p) => p.ref === "C6")!
		const t = (c6.rotation * Math.PI) / 180
		const end = (k: number) => Math.hypot(c6.x + k * 0.5 * Math.cos(t) - pad[0], c6.y + k * 0.5 * Math.sin(t) - pad[1])
		assert.ok(end(-1) <= end(1) + 0.25, `C6's pin 1 faces away from VINT with U5 turned ${rotationDeg}° (C6 at rotation ${c6.rotation})`)
	}
})
