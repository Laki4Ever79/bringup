import { test } from "node:test"
import assert from "node:assert/strict"
import { boardFacts, cableFacts, systemFacts } from "../src/system/facts.ts"
import { fixtureContract } from "./fixture.ts"
import type { SystemLink } from "../src/system/spec.ts"
import type { SystemAssembly } from "../src/system/assembly.ts"

const link = (over: Partial<SystemLink> = {}): SystemLink => ({ id: "L1", kind: "uart", a: { board: "main" }, b: { board: "climate" }, cable: { lengthMm: 300 }, messages: [{ name: "reading", from: "climate", fields: [] }, { name: "ack", from: "main", fields: [] }], ...over })

test("every board fact is a non-empty string (chip may be null), links are strings", () => {
	const f = boardFacts(fixtureContract(), "main", { body: "separate", boards: [] }, [link()])
	for (const k of ["size", "power", "mount", "debug"] as const) assert.ok(f[k].length > 0 && !f[k].includes("undefined"), k)
	assert.equal(f.size, "50 × 30 mm")
	assert.ok(f.chip === null || f.chip.length > 0)
	assert.deepEqual(f.links, ["L1 UART to climate"])
	assert.equal(f.mount, "in its case")
	assert.match(f.power, /3\.3 V/)
	assert.match(f.debug, /USB-C/)
})

test("an estimated outline says so; no contract at all shows dashes", () => {
	const asm: SystemAssembly = { body: "chassis", boards: [{ name: "climate", xMm: 0, yMm: 0, rotDeg: 0, outline: { widthMm: 40, heightMm: 30 }, outlineSource: "estimate" }] }
	const f = boardFacts(null, "climate", asm, [])
	assert.equal(f.size, "≈ 40 × 30 mm (estimate)")
	assert.equal(f.mount, "on the chassis")
	assert.equal(f.chip, null)
	assert.equal(f.debug, "—")
	assert.equal(boardFacts(null, "x", undefined, []).size, "—")
	assert.equal(boardFacts(null, "x", { body: "enclosure", boards: [] }, []).mount, "in the shared enclosure")
})

test("a board fed by a link's power says powered by L1; test pads off says no test pads", () => {
	const c = fixtureContract()
	c.values.requirements = { ...c.values.requirements!, testPads: false }
	const f = boardFacts(c, "climate", undefined, [link({ power: { from: "main" } })])
	assert.match(f.power, /powered by L1/)
	assert.match(f.debug, /^no test pads/)
	assert.doesNotMatch(boardFacts(c, "main", undefined, [link({ power: { from: "main" } })]).power, /powered by/)
})

test("cable facts for a UART link of 300 mm with two messages", () => {
	const c = cableFacts(link())
	assert.deepEqual(c, { kind: "UART", length: "300 mm", messages: ["reading from climate", "ack from main"], power: "each board has its own supply" })
	assert.equal(cableFacts(link({ power: { from: "main" } })).power, "main powers climate")
	const s = systemFacts({ main: fixtureContract() }, undefined, [link()])
	assert.deepEqual(Object.keys(s.cables), ["L1"])
	assert.deepEqual(Object.keys(s.boards), ["main"])
})

test("debug line: dash before anything is built, the placed pads on a built board, no test pads when off", () => {
	const c = fixtureContract()
	delete (c.values as { outline?: unknown }).outline
	c.values.requirements = { ...c.values.requirements!, testPads: true }
	assert.equal(boardFacts(c, "main", undefined, []).debug, "—")
	const built = fixtureContract()
	built.values.requirements = { ...built.values.requirements!, testPads: true }
	assert.match(boardFacts(built, "main", undefined, [], "k").debug, /^test pads: (GND|none placed)/)
	assert.match(boardFacts(built, "main", undefined, [], "k").debug, /USB-C/)
	built.values.requirements = { ...built.values.requirements!, testPads: false }
	assert.match(boardFacts(built, "main", undefined, []).debug, /^no test pads/)
})

test("power is never a dash beside a feed; an unbuilt board fed by a link says powered by L1", () => {
	assert.equal(boardFacts(null, "climate", undefined, [link({ power: { from: "main" } })]).power, "powered by L1")
	assert.equal(boardFacts(null, "climate", undefined, []).power, "—")
	assert.equal(cableFacts(link({ cable: undefined as never })).length, "—")
})

// Final review, Important 4: the debug port is named by the MCU's family (Espressif: its USB/UART download pinout; ST
// and Nordic: SWD), and only when the contract places it.
test("debug line names the port by MCU family, and only when the board has it", async () => {
	const { LOGGER_DESIGN, STM32_LOGGER_DESIGN } = await import("../src/inference/scripts.ts")
	const { debugPort } = await import("../src/codegen/circuit.ts")
	const { minimumBoard, resized } = await import("../src/contract/space.ts")
	// At its smallest board, as an outline change makes it: the connectors follow onto the new edges (the space model
	// judges each size so; keeping the old size's connectors left the STM32 logger's port no room at 40x19).
	const design = (d: typeof LOGGER_DESIGN) => {
		const s = fixtureContract()
		s.values = { ...s.values, ...structuredClone(d) }
		const m = minimumBoard(s)!
		return resized(s, m.widthMm, m.heightMm)
	}
	const esp = design(LOGGER_DESIGN)
	assert.ok(debugPort(esp).placed, "the ESP32 logger places its port")
	const espLine = boardFacts(esp, "main", undefined, []).debug
	assert.match(espLine, /debug port \(USB\/UART download\)/)
	assert.doesNotMatch(espLine, /SWD/)
	const st = design(STM32_LOGGER_DESIGN)
	assert.ok(debugPort(st).placed, "the STM32 logger places its port")
	assert.match(boardFacts(st, "main", undefined, []).debug, /debug port \(SWD\)/)
	// Off in the requirements, or no port possible (no pinout: the fixture's module lists no EN pin): none claimed.
	const off = design(LOGGER_DESIGN)
	off.values.requirements = { ...off.values.requirements!, debugPort: false }
	assert.doesNotMatch(boardFacts(off, "main", undefined, []).debug, /debug port|SWD/)
	const none = fixtureContract()
	assert.equal(debugPort(none).placed, null)
	assert.doesNotMatch(boardFacts(none, "main", undefined, []).debug, /debug port|SWD/)
})

test("a bought board's facts: where it comes from, its peak with the source, its carrier and its bridge device", () => {
	const boards = [{ name: "main", brief: "m.md" }, { name: "brain", kind: "bought" as const, module: "rpi-5" }, { name: "rpi-5-carrier", brief: "c.md", carries: "brain" }]
	const asm: SystemAssembly = { body: "chassis", plate: { lengthMm: 200, widthMm: 110 }, boards: [] }
	const f = systemFacts({ main: fixtureContract(), brain: null, "rpi-5-carrier": null }, asm, [], {}, boards).boards.brain
	assert.equal(f.bought!.from, "Raspberry Pi 5 (bought), on a generated carrier")
	assert.match(f.bought!.supply, /^5 A at 5\.1 V \(the supply the vendor asks for.*\): https:\/\/github\.com\/raspberrypi\/documentation\/.*power-supplies\.adoc \(table row Raspberry Pi 5: recommended PSU current capacity 5\.0A\)$/)
	assert.match(f.bought!.bridge, /^\/dev\/ttyACM0 \(the MCU board's native USB/)
	assert.match(f.bought!.carrier, /^rpi-5-carrier, a HAT on its header, 16 mm spacers: https:\/\/www\.raspberrypi\.com\/products\/m2-hat-plus/)
	assert.equal(f.size, "85 × 56 mm")
	assert.equal(f.mount, "on the chassis, rpi-5-carrier on top")
	assert.equal(systemFacts({ main: fixtureContract(), brain: null, "rpi-5-carrier": null }, asm, [], {}, boards).boards["rpi-5-carrier"].mount, "a HAT on brain's header, 16 mm spacers")
	assert.equal(f.chip, null)
	// Without the spec's boards it is just a board with no contract, as before.
	assert.equal(systemFacts({ brain: null }, asm, []).boards.brain.bought, undefined)
})
