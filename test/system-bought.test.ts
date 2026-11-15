// A bought board in a system (docs/superpowers/specs/2026-11-15-compute-modules-design.md): a compute module from the
import type { ContractSnapshot } from "../src/contract/types.ts"
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
	assert.match(specErrors(withPi({ module: "rpi-9" })).join("\n"), /board brain: no module rpi-9 in catalog\/modules \(compute modules: [^)]*\brpi-5\b[^)]*\)/)
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

test("a system of bought boards alone is refused: nothing to design (review C3)", () => {
	assert.match(specErrors({ name: "x", boards: [{ name: "brain", kind: "bought", module: "rpi-5" }], links: [] }).join("\n"), /at least one designed board/)
})

// The run path with a Pi (ruling R4, review I7): main (the rover), a bought rpi-5 and its HAT carrier on the catalog's
// 2S pack and D36V50F5, through spec validation, the carrier's brief, the assembly, a system run with stub boards and
// the robot board's own mechanics checks. No agent runs.
test("a rover with a Pi on a HAT carrier: valid spec, brief written, placed behind main, settles with the compute warnings and no overlap anywhere", async () => {
	const { addCarrier } = await import("../src/system/carrier.ts")
	const { moduleById } = await import("../src/system/bought.ts")
	const { ROVER_BOARD } = await import("../src/inference/scripts.ts")
	const { loadMechCatalog } = await import("../src/mechanics/catalog.ts")
	const { mechanicsChecks } = await import("../src/mechanics/checks.ts")
	const cat = loadMechCatalog(process.cwd())
	const pack = cat.batteries.find((b) => b.cells === 2)!, reg = cat.regulators![0]
	const base: SystemSpec = { name: "rover with a pi", boards: [{ name: "main", brief: "briefs/rover.md" }, { name: "brain", kind: "bought", module: "rpi-5" }], links: [] }
	const c = addCarrier(base, "brain", moduleById("rpi-5")!, { battery: pack })
	const spec: SystemSpec = { ...c.spec, boards: c.spec.boards.map((b) => (b.name === c.name ? { ...b, regulator: reg.mpn } : b)) }
	assert.deepEqual(specErrors(spec), [])
	assert.match(c.brief, new RegExp(`from the robot's ${pack.mpn.split(" ")[0]}.*so a buck converter`))
	// The boards' built outlines up front (the stubs don't settle again): main 60 × 40 mm, the HAT the Pi's 85 × 56.
	const withA = { ...spec, assembly: defaultAssembly(spec, "chassis", { main: { widthMm: 60, heightMm: 40 }, "rpi-5-carrier": { widthMm: 85, heightMm: 56 } }) }
	assert.deepEqual(assemblyErrors(withA), [])
	// main: the scripted rover on the 2S pack, with a brief large enough for a Pi (the starter's job: the rover brief's
	// 150 mm doesn't take a Pi beside the board).
	const rover = (): ContractSnapshot => {
		const s = fixtureContract()
		s.values = { ...structuredClone(ROVER_BOARD) } as ContractSnapshot["values"]
		s.values.mechanics!.battery.pack = pack.mpn
		s.values.motion = { ...s.values.motion!, maxSizeMm: [300, 200] }
		return s
	}
	const start: typeof startRunProcess = (a) => {
		const name = a.outDir.split("/").at(-1)!
		const hat = fixtureContract()
		hat.values.outline = { ...hat.values.outline!, widthMm: 85, heightMm: 56 }
		writeFileSync(join(a.outDir, "contract.json"), JSON.stringify(name === "main" ? rover() : hat))
		writeFileSync(join(a.outDir, "trace.jsonl"), JSON.stringify({ at: "2026-11-15T10:00:00Z", type: "design.settled", payload: { settled: true } }) + "\n")
		return { done: Promise.resolve({ code: 0, stderr: "", stdout: "" }), kill() {} }
	}
	const out = tempDir()
	const r = await runSystem({ spec: withA, outDir: out, mock: true, pollMs: 10, timeoutMs: 5000, start })
	const state = JSON.parse(readFileSync(join(out, "system-state.json"), "utf8"))
	const msgs = state.findings.map((f: { message: string }) => f.message).join("\n")
	assert.doesNotMatch(msgs, /overlap/)
	assert.equal(r.ok, true, `${state.status}\n${msgs}`)
	assert.deepEqual(state.findings.filter((f: { level?: string }) => f.level !== "warning"), [])
	assert.match(msgs, /brain: the carrier's rail is 5 V ±4 %/)
	assert.match(msgs, /brain: thin input headroom/)
	assert.match(msgs, /brain .*unknown height/)
	assert.match(readFileSync(join(out, "system-report.md"), "utf8"), /System findings: 0, and \d warning\(s\)/)
	// The robot board's own mechanics, with the body it was handed: no overlap between the Pi and its HAT.
	const asm = JSON.parse(readFileSync(join(out, "system.json"), "utf8")).assembly
	const s = rover()
	s.values.assembly = { ...asm, self: "main" }
	assert.deepEqual(mechanicsChecks(s).filter((v) => /overlap/.test(v.message)).map((v) => v.message), [])
	const x = (n: string) => asm.boards.find((b: { name: string }) => b.name === n).xMm
	assert.ok(x("brain") < x("main") && x("rpi-5-carrier") === x("brain"), "behind main, the HAT on the Pi")
})

test("boughtChecks: a brown-out is an error sent to the board with the mechanics; a missing regulator is a warning naming it; nothing for a system without a bought board", async () => {
	const { boughtChecks } = await import("../src/system/bought-checks.ts")
	const { ROVER_BOARD } = await import("../src/inference/scripts.ts")
	const spec: SystemSpec = { name: "s", boards: [{ name: "main", brief: "m.md" }, { name: "brain", kind: "bought", module: "rpi-5" }, { name: "hat", brief: "h.md", carries: "brain" }], links: [] }
	const main = fixtureContract()
	main.values = structuredClone(ROVER_BOARD) as ContractSnapshot["values"]
	const f = boughtChecks(spec, { main, hat: fixtureContract() })
	const err = f.filter((x) => x.level !== "warning")
	assert.equal(err.length, 1)
	assert.deepEqual([err[0].kind, err[0].boards], ["compute-power", ["main"]])
	assert.match(err[0].message, /^brain: brown-out risk/)
	assert.match(f.filter((x) => x.level === "warning").map((x) => x.message).join("\n"), /brain: rpi-5: the carrier's 5 V regulator isn't chosen yet/)
	assert.deepEqual(boughtChecks({ ...spec, boards: [spec.boards[0]] }, { main }), [])
})
