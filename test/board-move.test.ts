// Moving a part on the board page (engineer, 13 Nov 2026: step 3 after the "why" card and the swap; code checks on every
// move, the agents and the AI review only once the engineer sends the moves). With the robot direction (14 Nov: "modify
// each part individually … but keep it aware of rest of the system"): every move says what else it moves, on the board,
// in the case and across the system's cables, and a move the system can't take is refused before it is sent.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { circuitFromContract, layoutBoard } from "../src/codegen/circuit.ts"
import { placesAll } from "../src/contract/space.ts"
import { checkConsistency } from "../src/contract/consistency.ts"
import { LINK_CONNECTOR, linkChecks } from "../src/contract/links.ts"
import { checkMoves, movables, moveRequest, parseMoves } from "../src/dashboard/board-move.ts"
import { serveDashboard } from "../src/dashboard/server.ts"
import { runDesign } from "../src/run.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { fixtureContract } from "./fixture.ts"
import { tempDir } from "./helpers.ts"

const logger = (): ContractSnapshot => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	return s
}
const pin = (s: ContractSnapshot, ref: string, xMm: number, yMm: number) => {
	s.values.parts = s.values.parts!.map((p) => (p.ref === ref ? { ...p, at: { xMm, yMm } } : p))
	return s
}
const box = (s: ContractSnapshot, ref: string) => layoutBoard(s).parts.find((p) => p.ref === ref)

test("a part the engineer placed sits exactly there (its centre, from the board's bottom-left corner) and the rest place around it", () => {
	const s = pin(logger(), "U2", 30, 6)
	const u2 = box(s, "U2")!
	assert.deepEqual([u2.x + 25, u2.y + 15], [30, 6])
	// The board file tscircuit routes carries the same spot.
	assert.match(circuitFromContract(s), /name="U2"[^\n]*pcbX=\{5\} pcbY=\{-9\}/)
	const others = layoutBoard(s).parts.filter((p) => p.ref !== "U2")
	for (const o of others) assert.ok(Math.max(Math.abs(o.x - u2.x) - (o.w + u2.w) / 2, Math.abs(o.y - u2.y) - (o.h + u2.h) / 2) >= 0.9, `${o.ref} overlaps U2`)
})

test("a placed part that doesn't fit where it was put is never moved elsewhere: the check says what is in the way, to the parts owner", () => {
	const s = pin(logger(), "U2", 5, 15) // on top of the USB-C connector J1
	assert.equal(box(s, "U2"), undefined)
	const v = checkConsistency(s, {}).filter((x) => x.kind === "part-pinned-blocked")
	assert.equal(v.length, 1, JSON.stringify(checkConsistency(s, {}).map((x) => x.kind)))
	assert.match(v[0].message, /U2/)
	assert.match(v[0].message, /J1/)
	assert.deepEqual(v[0].affects, ["parts"])
	// Not "make the board bigger": the space check leaves a placed part to this one.
	assert.ok(!checkConsistency(s, {}).some((x) => x.kind === "space-room" && /U2/.test(x.message)))
})

test("the board can't be compacted past a part the engineer placed", () => {
	const s = pin(logger(), "U2", 36, 3)
	assert.equal(placesAll(s, 50, 30), true)
	assert.equal(placesAll(s, 38, 30), false, "U2's spot is off a 38 mm board")
})

test("a link connector off the edge the system runs its cable from is a violation for the architect, naming the peer", () => {
	const s = logger()
	s.values.parts = [...s.values.parts!, { ref: "J3", role: "connector", ...LINK_CONNECTOR, pins: [...LINK_CONNECTOR.pins] }]
	s.values.connectors = [...s.values.connectors!, { ref: "J3", kind: "header", edge: "top", offsetMm: 30, widthMm: 5.8, heightMm: 3 }]
	s.values.links = [{ id: "L1", kind: "uart", peer: "motor", connector: "J3", edge: "right", baud: 115200, txOn: "IO1", supply: "none" }]
	const v = linkChecks(s).filter((x) => x.kind === "link-edge")
	assert.equal(v.length, 1, JSON.stringify(linkChecks(s)))
	assert.match(v[0].message, /J3.*top.*right.*motor/s)
	s.values.connectors = s.values.connectors.map((c) => (c.ref === "J3" ? { ...c, edge: "right" as const, offsetMm: 15 } : c))
	assert.equal(linkChecks(s).filter((x) => x.kind === "link-edge").length, 0)
})

test("what can be moved: chosen parts and connectors, each with where it is; the module and generated parts say why not", () => {
	const m = movables(logger())
	assert.deepEqual(m.movable.U2, { ref: "U2", kind: "part", xMm: 25, yMm: 27 })
	assert.deepEqual(m.movable.J1, { ref: "J1", kind: "connector", edge: "left", offsetMm: 15, edges: { left: 30, right: 30, top: 50, bottom: 50 } })
	assert.match(m.fixed.U1, /antenna/)
	assert.equal(m.movable.U1, undefined)
})

test("each move is checked in code: where it lands, what moves with it, and the one request that sends them all", () => {
	const s = logger()
	const r = checkMoves(s, [{ ref: "U2", xMm: 30, yMm: 6 }, { ref: "J1", edge: "left", offsetMm: 10 }])
	assert.deepEqual(r.problems, [], JSON.stringify(r.problems))
	assert.equal(r.ok, true)
	const u2 = r.moves.find((m) => m.ref === "U2")!
	assert.equal(u2.from, "(25, 27) mm")
	assert.equal(u2.to, "(30, 6) mm")
	assert.ok(u2.effects.some((e) => /vent/.test(e)), u2.effects.join(" | ")) // a sensor under the case's grille
	const j1 = r.moves.find((m) => m.ref === "J1")!
	assert.equal(j1.scope, "case")
	assert.ok(j1.effects.some((e) => /opening/.test(e)), j1.effects.join(" | "))
	assert.ok(r.alsoMoved.includes("U3"), `the regulator sits a fixed distance in from the USB-C: ${r.alsoMoved}`)
	// The preview draws the board as it would be: U2's box at its new spot.
	const comp = (r.preview as { type: string; pcb_component_id?: string; center?: { x: number; y: number } }[]).find((e) => e.type === "pcb_component" && e.pcb_component_id === "pc_U2")!
	assert.deepEqual(comp.center, { x: 5, y: -9 })
	assert.equal(r.request, moveRequest(s, [{ ref: "U2", xMm: 30, yMm: 6 }, { ref: "J1", edge: "left", offsetMm: 10 }]))
	assert.deepEqual(parseMoves(r.request), [{ ref: "U2", xMm: 30, yMm: 6 }, { ref: "J1", edge: "left", offsetMm: 10 }])
})

test("a move that can't land is refused with the reason, before anything is sent", () => {
	const r = checkMoves(logger(), [{ ref: "U2", xMm: 5, yMm: 15 }])
	assert.equal(r.ok, false)
	assert.ok(r.problems.some((p) => p.kind === "part-pinned-blocked" && /J1/.test(p.message)), JSON.stringify(r.problems))
	// Off the board altogether.
	assert.equal(checkMoves(logger(), [{ ref: "U2", xMm: 80, yMm: 6 }]).ok, false)
	// A connector past its edge's end.
	assert.equal(checkMoves(logger(), [{ ref: "J1", edge: "left", offsetMm: 40 }]).ok, false)
})

test("a link connector moved off the system's edge is refused as a system change: the cable to the peer would have to change", () => {
	const s = logger()
	s.values.parts = [...s.values.parts!, { ref: "J3", role: "connector", ...LINK_CONNECTOR, pins: [...LINK_CONNECTOR.pins] }]
	s.values.connectors = [...s.values.connectors!, { ref: "J3", kind: "header", edge: "right", offsetMm: 6, widthMm: 5.8, heightMm: 3 }]
	s.values.links = [{ id: "L1", kind: "uart", peer: "motor", connector: "J3", edge: "right", baud: 115200, txOn: "IO1", supply: "none" }]
	const along = checkMoves(s, [{ ref: "J3", edge: "right", offsetMm: 25 }])
	const j3 = along.moves[0]
	assert.equal(j3.scope, "system")
	assert.ok(j3.effects.some((e) => /L1.*motor/.test(e)), j3.effects.join(" | "))
	const off = checkMoves(s, [{ ref: "J3", edge: "top", offsetMm: 30 }])
	assert.equal(off.ok, false)
	assert.ok(off.problems.some((p) => p.kind === "link-edge" && p.system), JSON.stringify(off.problems))
})

test("the board API checks moves without touching the run (POST /api/runs/:id/board/check)", async () => {
	const root = mkdtempSync(join(tmpdir(), "move-hub-"))
	const dir = join(root, "run-1")
	mkdirSync(join(dir, "contracts"), { recursive: true })
	writeFileSync(join(dir, "contracts", "rev-1.json"), JSON.stringify({ ...logger(), revision: 1 }))
	writeFileSync(join(dir, "trace.jsonl"), "")
	const dash = await serveDashboard(dir, 0)
	try {
		const board = (await (await fetch(`${dash.url}/api/runs/run-1/board`)).json()) as { movable: Record<string, unknown>; fixed: Record<string, string> }
		assert.ok(board.movable.U2)
		assert.ok(board.fixed.U1)
		const res = await fetch(`${dash.url}/api/runs/run-1/board/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ moves: [{ ref: "U2", xMm: 30, yMm: 6 }] }) })
		assert.equal(res.status, 200)
		const r = (await res.json()) as { ok: boolean; request: string }
		assert.equal(r.ok, true)
		assert.match(r.request, /U2 \(25, 27\) → \(30, 6\) mm/)
		const bad = await fetch(`${dash.url}/api/runs/run-1/board/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ moves: [{ ref: "U1", xMm: 1, yMm: 1 }] }) })
		assert.equal(((await bad.json()) as { ok: boolean }).ok, false)
		assert.equal(readFileSync(join(dir, "trace.jsonl"), "utf8"), "", "a check sends nothing")
	} finally {
		await dash.close()
		rmSync(root, { recursive: true, force: true })
	}
})

test("a scripted logger run takes the moves: U2 stays where the engineer put it, J1 moves along its edge, and it settles", { timeout: 300_000 }, async () => {
	const out = tempDir()
	// The scripted logger compacts to 35×25 mm, U2 at (17.5, 22), J1 left@12.5, before the request goes out; (10, 20) is
	// clear there (checkMoves on that revision). The agents read only where each goes.
	const request = moveRequest(logger(), [{ ref: "U2", xMm: 10, yMm: 20 }, { ref: "J1", edge: "left", offsetMm: 10 }])
	const r = await runDesign({ brief: readFileSync("briefs/logger.md", "utf8"), mock: true, noHardware: true, review: false, outDir: out, changes: [request], changeTimeoutMs: 30_000 })
	assert.equal(r.settled, true)
	assert.deepEqual(r.violations, [])
	const c = JSON.parse(readFileSync(join(out, "contract.json"), "utf8")) as ContractSnapshot
	assert.deepEqual(c.values.parts!.find((p) => p.ref === "U2")!.at, { xMm: 10, yMm: 20 })
	assert.deepEqual(c.values.connectors!.find((k) => k.ref === "J1"), { ref: "J1", kind: "usb-c", edge: "left", offsetMm: 10, widthMm: 9, heightMm: 3.5 })
	const u2 = layoutBoard(c).parts.find((p) => p.ref === "U2")!
	assert.deepEqual([u2.x + c.values.outline!.widthMm / 2, u2.y + c.values.outline!.heightMm / 2], [10, 20])
})
