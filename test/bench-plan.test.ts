// The system's bench test plan (docs/system.md, phase 2): generated from the spec and the boards' contracts, the same
// way the cable drawing is, with the expected lines the checker (py/bench_system.py) judges the boards' USB output by.
import { test } from "node:test"
import assert from "node:assert/strict"
import { benchPlan, benchPlanMarkdown, expectedValues } from "../src/system/bench-plan.ts"
import { boardLinks } from "../src/system/derive.ts"
import { LINK_CONNECTOR } from "../src/contract/links.ts"
import { linkProposal, LOGGER_DESIGN } from "../src/inference/scripts.ts"
import type { SystemLink, SystemSpec } from "../src/system/spec.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { fixtureContract } from "./fixture.ts"

const reading = { name: "reading", from: "logger", fields: [{ name: "tempCx100", type: "i16" as const }, { name: "rhx100", type: "u16" as const }] }
const uart = (over: Partial<SystemLink> = {}): SystemLink => ({ id: "L1", kind: "uart", a: { board: "logger" }, b: { board: "beacon" }, cable: { lengthMm: 300 }, messages: [reading], ...over })
const spec = (links: SystemLink[]): SystemSpec => ({ name: "logger and beacon", boards: [{ name: "logger", brief: "l.md" }, { name: "beacon", brief: "b.md" }, { name: "display", brief: "d.md" }], links })

function board(s: SystemSpec, name: string): ContractSnapshot {
	const c = fixtureContract()
	c.values = { ...c.values, ...structuredClone(LOGGER_DESIGN) }
	c.values.links = boardLinks(s, name)
	for (const l of c.values.links) c.values.parts = [...c.values.parts!, { ref: l.connector, role: "connector", ...LINK_CONNECTOR }]
	for (let next = linkProposal(c); next; next = linkProposal(c)) (c.values as Record<string, unknown>)[next.field] = next.value
	return c
}
const contracts = (s: SystemSpec) => Object.fromEntries(s.boards.map((b) => [b.name, board(s, b.name)]))
const dirs = { logger: "out/sys/boards/logger/firmware/rev-7", beacon: "out/sys/boards/beacon/firmware/rev-5", display: null }

test("the link test's known reading, by field name; any other field is expected as 0", () => {
	assert.deepEqual(expectedValues([{ name: "tempCx100" }, { name: "rhx100" }, { name: "tempC" }, { name: "rh" }, { name: "ok" }, { name: "battery" }]), { tempCx100: 2150, rhx100: 4025, tempC: 21.5, rh: 40.25, ok: 1, battery: 0 })
})

test("a UART link without power: boards alone, the cable, the link, pulling the cable, then the product firmware", () => {
	const s = spec([uart()])
	const p = benchPlan(s, contracts(s), dirs)
	assert.deepEqual(p.steps.map((x) => x.title), ["Each board alone", "The cable", "The link", "Pull the cable", "The product firmware"])
	assert.ok(p.steps[1].pass.some((l) => /L1.*pin 2 \(VCC\).*no wire/.test(l)), p.steps[1].pass.join("\n"))
	assert.deepEqual(p.expect, [{ board: "beacon", link: "L1", message: "reading", from: "logger", prefix: "LINK L1 reading from logger:", fields: { tempCx100: 2150, rhx100: 4025 } }])
	// Only the boards on a link are in the plan.
	assert.deepEqual(p.boards.map((b) => b.name), ["logger", "beacon"])
})

test("a link that carries power gets a power step: 3V3 at the other board's pin 2, the other board on no USB", () => {
	const s = spec([uart({ power: { from: "logger" } })])
	const step = benchPlan(s, contracts(s), dirs).steps.find((x) => x.title === "Power over the cable")
	assert.ok(step, "no power step")
	assert.ok(step.do.some((l) => /USB on logger only/.test(l)), step.do.join("\n"))
	assert.ok(step.pass.some((l) => /beacon's JL1 pin 2.*3\.2 to 3\.4 V/.test(l)), step.pass.join("\n"))
	assert.ok(step.pass.some((l) => /estimate/.test(l)), "the tolerance is an estimate and must say so")
})

test("an I2C link: the bench is its only running test, and the controller's message is expected at the target", () => {
	const s = spec([uart({ kind: "i2c", i2c: { controller: "logger", targets: { beacon: 0x42 }, pullupsOn: "logger" } })])
	const p = benchPlan(s, contracts(s), dirs)
	const link = p.steps.find((x) => x.title === "The link")!
	assert.ok(link.do.concat(link.pass).some((l) => /L1 is I2C: QEMU can't join two buses, so this is its only running test/.test(l)))
	assert.deepEqual(p.expect.map((e) => [e.board, e.prefix]), [["beacon", "LINK L1 reading from logger:"]])
})

test("two links: every message on every link is expected, and the plan names each board's firmware folder", () => {
	const second = uart({ id: "L2", a: { board: "beacon" }, b: { board: "display" }, messages: [{ ...reading, from: "beacon" }] })
	const s = spec([uart(), second])
	const p = benchPlan(s, contracts(s), dirs)
	assert.deepEqual(p.expect.map((e) => `${e.board} ${e.prefix}`), ["beacon LINK L1 reading from logger:", "display LINK L2 reading from beacon:"])
	const md = benchPlanMarkdown(p)
	assert.match(md, /pio run -d out\/sys\/boards\/logger\/firmware\/rev-7 -e esp32c3_linktest_usb -t upload/)
	assert.match(md, /display: no firmware yet/)
	assert.match(md, /py\/bench_system\.py bench-plan\.json --port logger=<port> --port beacon=<port> --port display=<port>/)
})

test("a received line is judged by value: 21.5 and 21.50 are the same, a wrong or missing field is named", async () => {
	const { wrongFields } = await import("../src/system/linktest.ts")
	assert.deepEqual(wrongFields("LINK L1 reading from logger: tempC=21.50 rh=40.25", { tempC: 21.5, rh: 40.25 }), [])
	assert.deepEqual(wrongFields("LINK L1 reading from logger: tempCx100=2150 rhx100=4000", { tempCx100: 2150, rhx100: 4025 }), ["rhx100"])
	assert.deepEqual(wrongFields("LINK L1 reading from logger: tempCx100=2150", { tempCx100: 2150, rhx100: 4025 }), ["rhx100"])
	assert.deepEqual(wrongFields("LINK L1 reading from logger: t=0.00", { t: 0 }), [])
})

// The product firmware prints on UART0 (GPIO20/21), which a Bringup board doesn't wire out: the plan must not ask a
// person to read its USB output, and must say why its last step can't pass yet.
test("product-firmware steps ask only for what a real board shows: its USB port, its LED; the last step says why it can't pass yet", () => {
	const s = spec([uart()])
	const p = benchPlan(s, contracts(s), dirs)
	const alone = p.steps[0]
	assert.ok(alone.do.some((l) => l.includes("pio run -d out/sys/boards/logger/firmware/rev-7 -t upload")), alone.do.join("\n"))
	assert.ok(!alone.pass.some((l) => /SENSOR OK/.test(l)), "the product firmware's output isn't on USB")
	assert.ok(alone.pass.some((l) => /logger: its USB port appears on the computer/.test(l)), alone.pass.join("\n"))
	assert.ok(alone.pass.some((l) => /logger: its LED blinks at each reading/.test(l)), "the logger has an LED")
	const product = p.steps.at(-1)!
	assert.ok(product.pass.some((l) => /can't pass on a real board yet.*UART0 \(GPIO20\/21\)/.test(l)), product.pass.join("\n"))
})
