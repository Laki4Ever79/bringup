import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { applyLaneEvent, createLanes, LANES } from "../src/dashboard/lanes.js"
import { featureEdges, parseStl } from "../src/dashboard/stl.js"
import { serveDashboard } from "../src/dashboard/server.ts"

let seq = 0
const ev = (type: string, payload: object, producerId = "p") => ({ seq: seq++, at: new Date().toISOString(), type, producerId, payload })
const activity = (role: string, phase: string, text: string) => ev("agent.activity", { agentId: `id-${role}`, role, name: role, phase, text, at: new Date().toISOString() })
const changed = (field: string, version: number, revision: number) => ev("contract.changed", { field, version, revision, by: "architect" })

test("lanes: one row per participant, agents first", () => {
	assert.deepEqual(LANES.map((l: { label: string }) => l.label), ["Architect", "Part selector", "Firmware reviewer", "Brief reviewer", "Board", "Enclosure", "Firmware build", "Grounding check", "Consistency"])
})

test("an agent.activity line updates that agent's lane: status, text, history", () => {
	const lanes = createLanes()
	assert.deepEqual(applyLaneEvent(lanes, activity("architect", "turn", "Brief from the engineer: logger")), ["architect"])
	assert.equal(lanes.architect.status, "thinking")
	assert.equal(lanes.architect.text, "Brief from the engineer: logger")
	applyLaneEvent(lanes, activity("architect", "tool", "propose_contract_change: outline ← {…} (base v0)"))
	assert.equal(lanes.architect.status, "tool")
	applyLaneEvent(lanes, activity("firmware", "held", "held for approval: propose_contract_change pins"))
	assert.equal(lanes.firmware.status, "held")
	applyLaneEvent(lanes, activity("architect", "answer", "contract drafted"))
	assert.equal(lanes.architect.status, "idle")
	assert.deepEqual(lanes.architect.history.map((h: { text: string }) => h.text), ["Brief from the engineer: logger", "propose_contract_change: outline ← {…} (base v0)", "contract drafted"])
	assert.equal(lanes.parts.status, "idle", "other lanes untouched")
})

test("builders show building only once their required fields exist, then done or failed", () => {
	const lanes = createLanes()
	applyLaneEvent(lanes, changed("parts", 1, 2))
	assert.equal(lanes["build:board"].status, "idle", "no outline yet: the board waits")
	assert.equal(lanes["build:firmware"].status, "idle", "no pins yet")
	applyLaneEvent(lanes, changed("outline", 1, 3))
	applyLaneEvent(lanes, changed("connectors", 1, 4))
	assert.equal(lanes["build:enclosure"].status, "building")
	applyLaneEvent(lanes, changed("pins", 1, 6))
	assert.equal(lanes["build:board"].status, "building")
	assert.equal(lanes["build:firmware"].status, "building")
	applyLaneEvent(lanes, ev("artifact.ready", { kind: "board", revision: 6 }))
	assert.equal(lanes["build:board"].status, "done")
	assert.match(lanes["build:board"].text, /rev 6/)
	applyLaneEvent(lanes, ev("artifact.failed", { kind: "firmware", revision: 6, error: "main.cpp:3: error: x\nmore" }))
	assert.equal(lanes["build:firmware"].status, "failed")
	assert.equal(lanes["build:firmware"].text, "rev 6 failed: main.cpp:3: error: x")
})

test("an older build finishing keeps the lane building while a newer one is queued", () => {
	const lanes = createLanes()
	applyLaneEvent(lanes, changed("parts", 1, 2))
	applyLaneEvent(lanes, changed("pins", 1, 6))
	applyLaneEvent(lanes, changed("pins", 2, 7))
	applyLaneEvent(lanes, ev("artifact.ready", { kind: "firmware", revision: 6 }))
	assert.equal(lanes["build:firmware"].status, "building")
	assert.equal(lanes["build:firmware"].text, "rev 6 built · building rev 7…")
	applyLaneEvent(lanes, ev("artifact.ready", { kind: "firmware", revision: 7 }))
	assert.equal(lanes["build:firmware"].status, "done")
})

test("checks: grounding and consistency lanes", () => {
	const lanes = createLanes()
	applyLaneEvent(lanes, ev("grounding.checked", { revision: 2, findings: [] }))
	assert.equal(lanes.grounding.status, "done")
	applyLaneEvent(lanes, ev("grounding.checked", { revision: 3, findings: [{ kind: "unknown-pin" }] }))
	assert.equal(lanes.grounding.status, "failed")
	applyLaneEvent(lanes, ev("consistency.checked", { revision: 4, violations: [{ kind: "net-missing", message: "m" }] }))
	assert.equal(lanes.consistency.status, "failed")
	assert.match(lanes.consistency.text, /1 violation/)
	applyLaneEvent(lanes, ev("design.settled", { revision: 7, settled: true }))
	assert.equal(lanes.consistency.status, "done")
	assert.match(lanes.consistency.text, /settled at rev 7/)
})

test("a halted agent's lane turns failed", () => {
	const lanes = createLanes()
	applyLaneEvent(lanes, activity("parts", "turn", "choose parts"))
	assert.deepEqual(applyLaneEvent(lanes, ev("agent.halted", { agentId: "id-parts", error: "429 rate limited\nretry" })), ["parts"])
	assert.equal(lanes.parts.status, "failed")
	assert.equal(lanes.parts.text, "halted: 429 rate limited")
	assert.deepEqual(applyLaneEvent(lanes, ev("agent.halted", { agentId: "unknown", error: "x" })), [])
})

test("each lane keeps its last result: tool results, answers and finished builds", () => {
	const lanes = createLanes()
	applyLaneEvent(lanes, activity("architect", "tool", "propose_contract_change: outline"))
	applyLaneEvent(lanes, activity("architect", "tool-result", "applied (v1, rev 3)"))
	assert.equal(lanes.architect.lastResult, "applied (v1, rev 3)")
	applyLaneEvent(lanes, activity("architect", "thinking", "thinking…"))
	assert.equal(lanes.architect.lastResult, "applied (v1, rev 3)", "thinking doesn't replace it")
	applyLaneEvent(lanes, activity("architect", "answer", "contract drafted"))
	assert.equal(lanes.architect.lastResult, "contract drafted")
	applyLaneEvent(lanes, ev("artifact.ready", { kind: "board", revision: 6 }))
	assert.equal(lanes["build:board"].lastResult, "rev 6 built")
	assert.equal(lanes.parts.lastResult, "")
})

test("when the design settles, agents still marked active go idle", () => {
	const lanes = createLanes()
	applyLaneEvent(lanes, activity("reviewer", "thinking", "thinking…"))
	applyLaneEvent(lanes, activity("architect", "answer", "contract drafted"))
	const changed = applyLaneEvent(lanes, ev("design.settled", { revision: 8, settled: true }))
	assert.ok(changed.includes("reviewer"))
	assert.equal(lanes.reviewer.status, "idle")
	assert.equal(lanes.reviewer.text, "run ended")
	assert.equal(lanes.architect.text, "contract drafted", "idle agents keep their last line")
	assert.equal(lanes.consistency.status, "done")
})

test("loop events that arrive after the design settled don't wake the lane again", () => {
	const lanes = createLanes()
	applyLaneEvent(lanes, ev("design.settled", { revision: 8, settled: true }))
	applyLaneEvent(lanes, activity("reviewer", "thinking", "thinking…"))
	assert.equal(lanes.reviewer.status, "idle")
	applyLaneEvent(lanes, activity("reviewer", "answer", "review submitted"))
	assert.equal(lanes.reviewer.status, "idle")
	assert.equal(lanes.reviewer.text, "review submitted")
})

test("firmware.booted puts a boot badge on the firmware build lane", () => {
	const lanes = createLanes()
	applyLaneEvent(lanes, ev("artifact.ready", { kind: "firmware", revision: 7 }))
	assert.equal(lanes["build:firmware"].boot, null)
	const changed = applyLaneEvent(lanes, ev("firmware.booted", { revision: 7, booted: true, bootRevision: 7, serialTail: "ESP-ROM:esp32c3\nbringup rev 7\nSENSOR FAIL" }))
	assert.deepEqual(changed, ["build:firmware"])
	assert.deepEqual(lanes["build:firmware"].boot, { ok: true, revision: 7, bootRevision: 7, lastLine: "SENSOR FAIL", tail: "ESP-ROM:esp32c3\nbringup rev 7\nSENSOR FAIL" })
	assert.equal(lanes["build:firmware"].status, "done", "the build status is unchanged")
	applyLaneEvent(lanes, ev("firmware.booted", { revision: 8, booted: false, bootRevision: null, serialTail: "rst:0x3\nGuru Meditation Error\n" }))
	assert.equal(lanes["build:firmware"].boot.ok, false)
	assert.equal(lanes["build:firmware"].boot.lastLine, "Guru Meditation Error")
	assert.match(lanes["build:firmware"].history.at(-1).text, /did not boot/)
})

test("history is capped", () => {
	const lanes = createLanes()
	for (let i = 0; i < 100; i++) applyLaneEvent(lanes, activity("parts", "thinking", `t${i}`))
	assert.ok(lanes.parts.history.length <= 40)
	assert.equal(lanes.parts.history.at(-1).text, "t99")
})

// A unit cube as 12 triangles (2 per face).
function cubeTriangles(): number[][][] {
	const v = (x: number, y: number, z: number) => [x, y, z]
	const quads = [
		[v(0, 0, 0), v(1, 0, 0), v(1, 1, 0), v(0, 1, 0)],
		[v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)],
		[v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)],
		[v(0, 1, 0), v(1, 1, 0), v(1, 1, 1), v(0, 1, 1)],
		[v(0, 0, 0), v(0, 1, 0), v(0, 1, 1), v(0, 0, 1)],
		[v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)],
	]
	return quads.flatMap(([a, b, c, d]) => [[a, b, c], [a, c, d]])
}

function binaryStl(tris: number[][][]): ArrayBuffer {
	const buf = new ArrayBuffer(84 + 50 * tris.length)
	const dv = new DataView(buf)
	dv.setUint32(80, tris.length, true)
	tris.forEach((t, i) => t.forEach((p, j) => p.forEach((c, k) => dv.setFloat32(84 + i * 50 + 12 + j * 12 + k * 4, c, true))))
	return buf
}

test("STL: binary and ASCII parse to the same triangles", () => {
	const tris = cubeTriangles()
	const ascii = "solid cube\n" + tris.map((t) => `facet normal 0 0 0\nouter loop\n${t.map((p) => `vertex ${p.join(" ")}`).join("\n")}\nendloop\nendfacet`).join("\n") + "\nendsolid cube\n"
	const b = parseStl(binaryStl(tris))
	const a = parseStl(new TextEncoder().encode(ascii).buffer)
	assert.equal(b.length, 12 * 9)
	assert.deepEqual(Array.from(a), Array.from(b))
})

test("STL: feature edges of a cube are its 12 edges, not the face diagonals", () => {
	assert.equal(featureEdges(parseStl(binaryStl(cubeTriangles()))).length, 12)
})

test("the dashboard serves its page modules", async () => {
	const dir = mkdtempSync(join(tmpdir(), "bringup-lanes-"))
	writeFileSync(join(dir, "trace.jsonl"), "")
	const dash = await serveDashboard(dir, 0)
	try {
		for (const m of ["lanes.js", "stl.js"]) {
			const res = await fetch(`${dash.url}/${m}`)
			assert.equal(res.status, 200, m)
			assert.match(res.headers.get("content-type") ?? "", /javascript/)
		}
		const page = await (await fetch(dash.url)).text()
		assert.match(page, /from "\/lanes\.js"/)
		assert.match(page, /from "\/stl\.js"/)
		assert.match(page, /from "\/model\.js"/)
		for (const id of ["stage", "agents", "parts", "prs", "dots", "change-input", "start"]) assert.match(page, new RegExp(`id="${id}"`))
		assert.equal((await fetch(`${dash.url}/server.ts`)).status, 404, "only the page modules are served from the dashboard folder")
	} finally {
		await dash.close()
	}
})

test("the firmware lane builds again when the behavior changes, like the firmware builder", async () => {
	const { BUILD_INPUTS } = await import("../src/agents/builders.ts")
	assert.ok(BUILD_INPUTS.firmware.includes("behavior"))
	const lanes = createLanes()
	applyLaneEvent(lanes, changed("parts", 1, 1))
	applyLaneEvent(lanes, changed("pins", 1, 2))
	applyLaneEvent(lanes, ev("artifact.ready", { kind: "firmware", revision: 2 }))
	assert.equal(lanes["build:firmware"].status, "done")
	applyLaneEvent(lanes, changed("behavior", 1, 3))
	assert.equal(lanes["build:firmware"].status, "building")
})

test("the firmware lane builds again when the requirements change (the duty-cycle period), like the firmware builder", async () => {
	const { BUILD_INPUTS } = await import("../src/agents/builders.ts")
	assert.ok(BUILD_INPUTS.firmware.includes("requirements"))
	const lanes = createLanes()
	applyLaneEvent(lanes, changed("parts", 1, 1))
	applyLaneEvent(lanes, changed("pins", 1, 2))
	applyLaneEvent(lanes, ev("artifact.ready", { kind: "firmware", revision: 2 }))
	applyLaneEvent(lanes, changed("requirements", 2, 3))
	assert.equal(lanes["build:firmware"].status, "building")
})
