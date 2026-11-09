// Systems of boards (docs/system.md): each board's side of a link, the board-level checks, the checks between boards,
// the cable, and a scripted two-board system that settles.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { checkConsistency } from "../src/contract/consistency.ts"
import { linkChecks, linksShapeError, LINK_CONNECTOR } from "../src/contract/links.ts"
import { circuitFromContract, generatedNets, supportParts } from "../src/codegen/circuit.ts"
import { linkHeader } from "../src/codegen/firmware.ts"
import { boardLinks, messageHash } from "../src/system/derive.ts"
import { systemChecks } from "../src/system/checks.ts"
import { cableMarkdown, wirevizYaml } from "../src/system/outputs.ts"
import { loadSpec, specErrors, type SystemSpec } from "../src/system/spec.ts"
import { linkProposal, LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { runSystem } from "../src/system/run.ts"
import { fixtureContract } from "./fixture.ts"
import { tempDir } from "./helpers.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

const uartSpec = (): SystemSpec => ({
	name: "two loggers",
	boards: [{ name: "a", brief: "x.md" }, { name: "b", brief: "y.md" }],
	links: [{ id: "L1", kind: "uart", a: { board: "a" }, b: { board: "b" }, cable: { lengthMm: 300 }, messages: [{ name: "reading", from: "a", fields: [{ name: "t", type: "i16" }] }] }],
})
const i2cSpec = (over: Partial<SystemSpec["links"][0]> = {}): SystemSpec => ({
	...uartSpec(),
	links: [{ id: "L1", kind: "i2c", a: { board: "a" }, b: { board: "b" }, i2c: { controller: "a", targets: { b: 0x42 }, pullupsOn: "a" }, cable: { lengthMm: 200 }, ...over }],
})

// A logger board that has done everything its links ask: the connector placed, the UART pins on it.
function board(spec: SystemSpec, name: string, sensor = true): ContractSnapshot {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	if (!sensor) {
		s.values.parts = s.values.parts!.filter((p) => !["U2", "R5", "R6"].includes(p.ref))
		s.values.pins = s.values.pins!.filter((p) => p.partRef !== "U2")
	}
	s.values.links = boardLinks(spec, name)
	for (const l of s.values.links) s.values.parts = [...s.values.parts!, { ref: l.connector, role: "connector", ...LINK_CONNECTOR }]
	for (let next = linkProposal(s); next; next = linkProposal(s)) (s.values as Record<string, unknown>)[next.field] = next.value
	return s
}

test("each board gets its side of the link: UART TX crossed between the ends, one message hash on both", () => {
	const spec = uartSpec()
	const [a, b] = [boardLinks(spec, "a")[0], boardLinks(spec, "b")[0]]
	assert.deepEqual([a.txOn, b.txOn], ["IO1", "IO2"])
	assert.deepEqual([a.connector, b.connector], ["JL1", "JL1"])
	assert.deepEqual([a.messages![0].dir, b.messages![0].dir], ["send", "receive"])
	assert.equal(a.messages![0].hash, b.messages![0].hash)
	assert.equal(a.messages![0].hash, messageHash({ name: "reading", fields: [{ name: "t", type: "i16" }] }))
	assert.equal(linksShapeError([a, b]), null)
	assert.match(String(linksShapeError([{ ...a, txOn: undefined }])), /needs baud and txOn/)
	const [ia, ib] = [boardLinks(i2cSpec(), "a")[0], boardLinks(i2cSpec(), "b")[0]]
	assert.deepEqual([ia.i2c!.role, ib.i2c!.role, ib.i2c!.address, ia.i2c!.pullups, ib.i2c!.pullups], ["controller", "target", 0x42, true, false])
})

test("the spec is checked before anything runs", () => {
	assert.deepEqual(specErrors(uartSpec()), [])
	const bad = uartSpec()
	bad.links[0].b.board = "nope"
	bad.links[0].id = "l1"
	assert.deepEqual(specErrors(bad).length, 2)
	assert.ok(specErrors(i2cSpec({ i2c: { controller: "c", targets: { b: 3 }, pullupsOn: "a" } })).some((e) => /controller c is not on the link/.test(e)))
	assert.ok(specErrors(i2cSpec({ i2c: { controller: "a", targets: { b: 3 }, pullupsOn: "a" } })).some((e) => /7-bit/.test(e)))
	const loaded = loadSpec("briefs/systems/logger-beacon-uart.json")
	assert.deepEqual(specErrors(loaded), [])
	assert.match(loaded.boards[0].brief!, /briefs\/logger\.md$/)
})

test("a board's own checks wake its agents: the connector part, its edge, the UART pins, a regulator fed from the link", () => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN), links: boardLinks(uartSpec(), "a") }
	assert.deepEqual(linkChecks(s).map((v) => [v.kind, v.affects[0]]), [["link-connector-missing", "parts"], ["link-unwired", "architect"]])
	s.values.parts = [...s.values.parts!, { ref: "JL1", role: "connector", ...LINK_CONNECTOR }]
	assert.deepEqual(linkChecks(s).map((v) => [v.kind, v.affects[0]]), [["link-connector-missing", "architect"], ["link-unwired", "architect"]])
	const done = board(uartSpec(), "a")
	assert.deepEqual(linkChecks(done), [])
	assert.ok(!checkConsistency(done, {}).some((v) => v.kind.startsWith("link-")))
	const powered = board({ ...uartSpec(), links: [{ ...uartSpec().links[0], power: { from: "b" } }] }, "a")
	assert.deepEqual(linkChecks(powered).map((v) => v.kind), ["link-supply-conflict"])
})

test("the generator wires a link connector: GND always, VCC only when the link carries power, I2C onto the board's bus, one set of pull-ups", () => {
	const plain = board(uartSpec(), "a")
	const nets = generatedNets(plain)
	assert.ok(nets.get("GND")!.includes("JL1.GND"))
	assert.ok(!nets.get("V3V3")?.includes("JL1.VCC") && ![...nets.values()].flat().includes("JL1.VCC"), "no power over the link: VCC unconnected")
	assert.match(circuitFromContract(plain), /from="\.JL1 > \.IO1" to="net\.L1_TX"/)
	const out = board({ ...uartSpec(), links: [{ ...uartSpec().links[0], power: { from: "a" } }] }, "a")
	assert.ok([...generatedNets(out).values()].flat().includes("JL1.VCC"))
	const controller = board(i2cSpec(), "a")
	assert.match(circuitFromContract(controller), /from="\.JL1 > \.IO1" to="net\.I2C_SDA"/)
	assert.match(circuitFromContract(controller), /from="\.JL1 > \.IO2" to="net\.I2C_SCL"/)
	assert.equal(supportParts(controller).filter((sp) => /pull-up/.test(sp.job)).length, 2)
	// The target with its own bus (I2C pins for the connector) fits no bus pull-ups: the controller's serve the bus. Its
	// I2C_SDA is on GPIO8, the download strap, which floats with the cable unplugged (as when its recovery pads are used),
	// so that one line keeps its own 10k (5k with the controller's in parallel, fine for I2C).
	const target = board(i2cSpec(), "b")
	const targetPullups = supportParts(target).filter((sp) => /pull-up/.test(sp.job))
	assert.deepEqual(targetPullups.map((sp) => [sp.job.replace(/ \(.*/, ""), sp.a]), target.values.pins!.some((p) => p.gpio === 8 && p.signal === "I2C_SDA") ? [["U1.GPIO8 pull-up", { net: "I2C_SDA" }]] : [])
	// A target with no bus of its own gets I2C_SDA/I2C_SCL straight on the connector, and no bus pull-ups (only the
	// download strap's, on GPIO8 when it is free).
	const bare = board(i2cSpec(), "b", false)
	assert.deepEqual(bare.values.pins!.filter((p) => p.partRef === "JL1").map((p) => [p.signal, p.partPin]), [["I2C_SDA", "IO1"], ["I2C_SCL", "IO2"]])
	assert.deepEqual(linkChecks(bare), [])
	assert.deepEqual(supportParts(bare).filter((sp) => /pull-up/.test(sp.job) && !sp.job.startsWith("U1.GPIO8 pull-up")), [])
	const h = linkHeader(plain)
	assert.match(h, /#define LINK_L1_UART 1/)
	assert.match(h, /#define LINK_L1_BAUD 115200/)
	assert.match(h, /struct __attribute__\(\(packed\)\) reading_msg \{\n\tint16_t t;\n\};/)
	assert.match(linkHeader(controller), /#define LINK_L1_I2C_CONTROLLER 1/)
	assert.match(linkHeader(target), /#define LINK_L1_I2C_ADDRESS 0x42/)
	assert.match(linkHeader(fixtureContract()), /#define LINK_COUNT 0/)
})

test("between boards: UART crossover and speed, the I2C bus's controller, addresses, pull-ups and cable, power, messages", () => {
	const spec = uartSpec()
	const ok = { a: board(spec, "a"), b: board(spec, "b") }
	assert.deepEqual(systemChecks(spec, ok), [])
	// b's RX on the same pin as a's RX: they don't meet through a straight cable.
	const crossed = structuredClone(ok)
	crossed.b.values.pins = crossed.b.values.pins!.map((p) => (p.signal === "L1_RX" ? { ...p, partPin: "IO2" } : p.signal === "L1_TX" ? { ...p, partPin: "IO1" } : p))
	assert.ok(systemChecks(spec, crossed).some((f) => f.kind === "uart-crossover"))
	assert.deepEqual(systemChecks(spec, { a: ok.a, b: undefined }).map((f) => f.kind), ["link-pending"])
	// I2C: the beacon-like target with no sensor is fine; a target that drives its own sensor is not (one controller).
	const i2c = i2cSpec()
	assert.deepEqual(systemChecks(i2c, { a: board(i2c, "a"), b: board(i2c, "b", false) }), [])
	assert.ok(systemChecks(i2c, { a: board(i2c, "a"), b: board(i2c, "b") }).some((f) => f.kind === "i2c-target-has-bus"))
	// The target at the SHT40's address (0x44) collides with the controller's own sensor.
	const clash = i2cSpec({ i2c: { controller: "a", targets: { b: 0x44 }, pullupsOn: "a" } })
	assert.ok(systemChecks(clash, { a: board(clash, "a"), b: board(clash, "b", false) }).some((f) => f.kind === "i2c-address" && /0x44/.test(f.message)))
	// 3 m of cable at 100 kHz: past the rise-time budget (an estimate, labelled as one).
	const long = i2cSpec({ cable: { lengthMm: 3000 } })
	const tooLong = systemChecks(long, { a: board(long, "a"), b: board(long, "b", false) }).find((f) => f.kind === "i2c-cable-too-long")
	assert.ok(tooLong?.estimate)
	// Power over 5 m of cable: the drop at the peer's 170 mA peak leaves it under 3.0 V.
	const powered: SystemSpec = { ...spec, links: [{ ...spec.links[0], power: { from: "a" }, cable: { lengthMm: 5000 } }] }
	const pa = board(powered, "a")
	const pb = board(powered, "b")
	assert.ok(systemChecks(powered, { a: pa, b: pb }).some((f) => f.kind === "link-voltage"))
	// The cable drawing: a straight cable, TX meeting RX.
	const cable = cableMarkdown(spec, ok)
	assert.match(cable, /\| 3 \| blue \| L1_TX \| L1_RX \|/)
	assert.match(cable, /\| 4 \| yellow \| L1_RX \| L1_TX \|/)
	assert.match(wirevizYaml(spec, ok), /a\.JL1:\n    type: JST SH/)
})

test("a scripted two-board UART system settles: each board takes its link, and the checks between them pass", { timeout: 300_000 }, async () => {
	const out = tempDir()
	const r = await runSystem({ spec: loadSpec("briefs/systems/logger-beacon-uart.json"), outDir: out, mock: true, boardArgs: ["--no-hardware", "--no-review"], pollMs: 500, timeoutMs: 240_000 })
	assert.equal(r.ok, true, readFileSync(r.reportPath, "utf8"))
	const report = readFileSync(join(out, "system-report.md"), "utf8")
	assert.match(report, /^Status: settled/m)
	assert.match(readFileSync(join(out, "cable.md"), "utf8"), /\| 3 \| blue \| L1_TX \| L1_RX \|/)
	for (const b of ["logger", "beacon"]) {
		const c = JSON.parse(readFileSync(join(out, "boards", b, "contract.json"), "utf8"))
		assert.deepEqual(c.values.links.map((l: { id: string }) => l.id), ["L1"])
		assert.ok(c.values.connectors.some((k: { ref: string }) => k.ref === "JL1"))
	}
})
