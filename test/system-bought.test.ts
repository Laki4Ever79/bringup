// A bought board in a system (docs/superpowers/specs/2026-11-15-compute-modules-design.md): a compute module from the
// module library that no agent designs. Its spec, its place in the assembly, the system run and the design page's payload.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { specErrors, type SystemSpec } from "../src/system/spec.ts"
import { assemblyErrors, defaultAssembly, mergeRequest, withOutlines } from "../src/system/assembly.ts"
import { boardsOverlap } from "../src/dashboard/assembly-geom.js"
import { runSystem } from "../src/system/run.ts"
import { serveHub } from "../src/dashboard/server.ts"
import type { startRunProcess } from "../src/runner/spawn-run.ts"
import { fixtureContract } from "./fixture.ts"
import { tempDir } from "./helpers.ts"

const withPi = (over: Partial<SystemSpec["boards"][0]> = {}): SystemSpec => ({
	name: "rover with a pi",
	boards: [{ name: "main", brief: "m.md" }, { name: "brain", kind: "bought", module: "rpi-5", ...over }],
	links: [],
})

test("a bought board needs a known compute module, and nothing to design", () => {
	assert.deepEqual(specErrors(withPi()), [])
	assert.match(specErrors(withPi({ module: "rpi-9" })).join("\n"), /board brain: no module rpi-9 in catalog\/modules \(compute modules: rpi-5\)/)
	assert.match(specErrors(withPi({ module: "climate-sht40" })).join("\n"), /board brain: module climate-sht40 is a sensor module, not a compute board/)
	assert.match(specErrors(withPi({ module: undefined })).join("\n"), /board brain: a bought board needs a module/)
	assert.match(specErrors(withPi({ brief: "x.md" })).join("\n"), /board brain: a bought board is not designed/)
	assert.match(specErrors({ ...withPi(), boards: [{ name: "main", brief: "m.md", module: "rpi-5" }] }).join("\n"), /a module is for a bought board/)
})

test("a carrier carries a bought board; links to the bought board itself are refused", () => {
	const carried: SystemSpec = { ...withPi(), boards: [...withPi().boards, { name: "brain-carrier", brief: "c.md", carries: "brain" }] }
	assert.deepEqual(specErrors(carried), [])
	assert.match(specErrors({ ...carried, boards: [...withPi().boards, { name: "c", brief: "c.md", carries: "main" }] }).join("\n"), /board c: it carries main, which is not a bought board/)
	assert.match(specErrors({ ...carried, boards: [...withPi().boards, { name: "c", brief: "c.md", carries: "nope" }] }).join("\n"), /board c: it carries nope, which is not in the system/)
	const linked: SystemSpec = { ...withPi(), links: [{ id: "L1", kind: "uart", a: { board: "main" }, b: { board: "brain" }, cable: { lengthMm: 100 } }] }
	assert.match(specErrors(linked).join("\n"), /link L1: brain is a bought board/)
})

test("a bought board is placed with its record's outline, built from the start; its HAT carrier on it", () => {
	const spec: SystemSpec = { ...withPi(), boards: [...withPi().boards, { name: "brain-carrier", brief: "c.md", carries: "brain" }] }
	const a = defaultAssembly(spec, "chassis")
	const brain = a.boards.find((b) => b.name === "brain")!
	assert.deepEqual([brain.outline, brain.outlineSource], [{ widthMm: 85, heightMm: 56 }, "built"])
	const carrier = a.boards.find((b) => b.name === "brain-carrier")!
	assert.deepEqual([carrier.xMm, carrier.yMm, carrier.rotDeg, carrier.carries], [brain.xMm, brain.yMm, brain.rotDeg, "brain"])
	assert.deepEqual(carrier.outline, { widthMm: 85, heightMm: 56 })
	assert.deepEqual(a.boards.map((b) => b.name), ["main", "brain", "brain-carrier"], "the spec's order")
	assert.deepEqual(assemblyErrors({ ...spec, assembly: a }), [], "a carrier and its board stack: no overlap, both on the plate")
	assert.ok(a.plate!.lengthMm >= 40 + 8 + 85 + 20, "the plate grew for the Pi")
	// Behind the MCU board (-x), clear of the distance sensor at the front (ruling R2), with the record's holes.
	const main = a.boards.find((b) => b.name === "main")!
	assert.equal(brain.xMm, main.xMm - 20 - 8 - 42.5)
	assert.equal(brain.holes!.length, 4)
	assert.deepEqual(carrier.holes, brain.holes)
})

const settling = (calls: string[]): typeof startRunProcess => (a) => {
	calls.push(a.outDir.split("/").at(-1)!)
	writeFileSync(join(a.outDir, "contract.json"), JSON.stringify(fixtureContract()))
	writeFileSync(join(a.outDir, "trace.jsonl"), JSON.stringify({ at: "2026-11-15T10:00:00Z", type: "design.settled", payload: { settled: true } }) + "\n")
	return { done: Promise.resolve({ code: 0, stderr: "", stdout: "" }), kill() {} }
}

test("a system run starts no agents for a bought board, and settles with its record's outline in the body", async () => {
	const spec = withPi()
	// A hand-written body that still has the Pi as an estimate: the run puts the record's outline in before anything starts.
	const assembly = defaultAssembly({ ...spec, boards: [spec.boards[0], { name: "brain", brief: "x.md" }] }, "chassis", { main: { ...fixtureContract().values.outline! } })
	const out = tempDir(), calls: string[] = []
	const r = await runSystem({ spec: { ...spec, assembly }, outDir: out, mock: true, pollMs: 10, timeoutMs: 3000, start: settling(calls) })
	assert.deepEqual(calls, ["main"], "only the designed board runs")
	assert.equal(r.ok, true, JSON.stringify(r.findings))
	const brain = JSON.parse(readFileSync(join(out, "system.json"), "utf8")).assembly.boards.find((b: { name: string }) => b.name === "brain")
	assert.deepEqual([brain.outline, brain.outlineSource], [{ widthMm: 85, heightMm: 56 }, "built"])
	const first = readFileSync(join(out, "boards", "main", "requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))[0]
	assert.deepEqual(first.assembly.boards.find((b: { name: string }) => b.name === "brain").outline, { widthMm: 85, heightMm: 56 }, "main is handed the Pi's real size")
	assert.match(readFileSync(join(out, "system-report.md"), "utf8"), /\| brain \| bought \(rpi-5\) \| rev 0 \| 85×56 mm \|/)
})

test("the design page's payload shows a bought board as bought, with its module, outline and holes", async () => {
	const root = tempDir(), dir = join(root, "system-pi")
	mkdirSync(dir, { recursive: true })
	const spec: SystemSpec = { ...withPi(), boards: [...withPi().boards, { name: "brain-carrier", brief: "c.md", carries: "brain" }] }
	writeFileSync(join(dir, "system.json"), JSON.stringify({ ...spec, assembly: defaultAssembly(spec, "chassis") }))
	const hub = await serveHub({ outRoot: root, port: 0 })
	try {
		const d = await (await fetch(`${hub.url}/api/systems/system-pi`)).json()
		const brain = d.boards.find((b: { name: string }) => b.name === "brain")
		assert.equal(brain.bought, true)
		assert.equal(brain.module, "rpi-5")
		assert.equal(brain.status, "bought")
		assert.equal(brain.carrier, "brain-carrier")
		assert.deepEqual(brain.outline, { widthMm: 85, heightMm: 56 })
		assert.equal(brain.holes.length, 4)
		assert.equal(brain.stack.mm, 16)
		assert.match(brain.stack.source.url, /raspberrypi\.com\/products\/m2-hat-plus/)
		const carrier = d.boards.find((b: { name: string }) => b.name === "brain-carrier")
		assert.deepEqual([carrier.carries, carrier.status], ["brain", "not started"])
	} finally {
		await hub.close()
	}
})

test("bought boards stand behind every designed board, even with a third board in the row (ruling R2)", () => {
	const spec: SystemSpec = { ...withPi(), boards: [{ name: "main", brief: "m.md" }, { name: "climate", brief: "c.md" }, { name: "brain", kind: "bought", module: "rpi-5" }, { name: "rpi-5-carrier", brief: "h.md", carries: "brain" }] }
	const a = defaultAssembly(spec, "chassis")
	const x = (n: string) => a.boards.find((b) => b.name === n)!.xMm
	const rear = Math.min(...["main", "climate"].map((n) => x(n) - 20))
	assert.equal(x("brain"), rear - 8 - 42.5)
	assert.ok(x("brain") < 0)
	assert.deepEqual(assemblyErrors({ ...spec, assembly: a }), [])
})

test("a carrier built bigger than the Pi moves with it as one unit, never left on another board (review I2)", () => {
	const spec: SystemSpec = { ...withPi(), boards: [...withPi().boards, { name: "rpi-5-carrier", brief: "c.md", carries: "brain" }] }
	const a = defaultAssembly(spec, "chassis")
	// The HAT comes back 120 mm long: as a unit with the Pi it must clear main.
	const grown = withOutlines(a, { "rpi-5-carrier": { widthMm: 120, heightMm: 56 } })
	const b = (n: string) => grown.boards.find((x) => x.name === n)!
	assert.deepEqual([b("rpi-5-carrier").xMm, b("rpi-5-carrier").yMm], [b("brain").xMm, b("brain").yMm])
	assert.deepEqual(assemblyErrors({ ...spec, assembly: grown }), [])
	assert.equal(boardsOverlap(b("rpi-5-carrier"), b("main")), false)
})

test("a request that moves the Pi brings its carrier along; a carrier off its board is an assembly error (review I3)", () => {
	const spec: SystemSpec = { ...withPi(), boards: [...withPi().boards, { name: "rpi-5-carrier", brief: "c.md", carries: "brain" }] }
	const withA = { ...spec, assembly: defaultAssembly(spec, "chassis") }
	const moved = withA.assembly.boards.map((x) => (x.name === "brain" ? { ...x, xMm: x.xMm - 10, yMm: 5, rotDeg: 180 as const } : x))
	const merged = mergeRequest(withA, { assembly: { boards: moved } })
	const c = merged.assembly!.boards.find((x) => x.name === "rpi-5-carrier")!, p = merged.assembly!.boards.find((x) => x.name === "brain")!
	assert.deepEqual([c.xMm, c.yMm, c.rotDeg], [p.xMm, p.yMm, 180])
	assert.match(assemblyErrors({ ...withA, assembly: { ...withA.assembly, boards: moved } }).join("\n"), /board rpi-5-carrier is a HAT on brain and must have its place and turn/)
})
