// The product firmware's console (docs/system.md, Firmware): a Bringup board wires out only the C3's own USB, and QEMU
// reads UART0, so every line goes to both. A USB write must never wait for a host: on battery nobody is listening.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT } from "../src/run.ts"
import { linkHeader } from "../src/codegen/firmware.ts"
import { benchPlan } from "../src/system/bench-plan.ts"
import { boardLinks } from "../src/system/derive.ts"
import { LINK_CONNECTOR } from "../src/contract/links.ts"
import { linkProposal, LOGGER_DESIGN } from "../src/inference/scripts.ts"
import type { SystemSpec } from "../src/system/spec.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { fixtureContract } from "./fixture.ts"

const main = readFileSync(join(ROOT, "templates/fw/src/main.cpp"), "utf8")
// The console itself lives in the per-chip layer (include/hal.h); this is its ESP32 code.
const hal = readFileSync(join(ROOT, "templates/fw/include/hal.h"), "utf8")
const halEsp32 = hal.slice(hal.indexOf("#if defined(ARDUINO_ARCH_ESP32)"), hal.indexOf("#elif defined(ARDUINO_ARCH_STM32)"))
// The product path: main.cpp without the bench build's own section (#ifdef BENCH up to its matching #else).
function withoutBench(src: string): string {
	const lines = src.split("\n")
	const start = lines.findIndex((l) => l.startsWith("#ifdef BENCH"))
	let depth = 0
	for (let i = start; i < lines.length; i++) {
		if (/^#if/.test(lines[i])) depth++
		else if (/^#endif/.test(lines[i])) depth--
		else if (depth === 1 && /^#else/.test(lines[i])) return [...lines.slice(0, start), ...lines.slice(i)].join("\n")
	}
	throw new Error("no #else for #ifdef BENCH")
}
const product = withoutBench(main)

test("the console writes every line to UART0 and to the USB port, and never waits for a USB host", () => {
	const console = halEsp32.slice(halEsp32.indexOf("struct Console"), halEsp32.indexOf("};", halEsp32.indexOf("struct Console")))
	assert.match(console, /Serial0\.write/)
	assert.match(console, /UsbLog\.write/)
	assert.match(halEsp32, /static HWCDC UsbLog;/)
	assert.match(halEsp32, /static HWCDC &UsbLog = HWCDCSerial;/)
	assert.match(halEsp32, /UsbLog\.setTxTimeoutMs\(0\)/)
	assert.match(main, /#include "hal\.h"/)
	assert.match(product, /logBegin\(\)/)
	assert.doesNotMatch(product, /\bSerial\.(print|printf|println|write|flush|begin)\(/, "the product path prints through Log, not Serial (UART0 only)")
})

const spec: SystemSpec = {
	name: "two loggers",
	boards: [{ name: "a", brief: "x.md" }, { name: "b", brief: "y.md" }],
	links: [{ id: "L1", kind: "uart", a: { board: "a" }, b: { board: "b" }, cable: { lengthMm: 300 }, messages: [{ name: "reading", from: "a", fields: [{ name: "tempCx100", type: "i16" }] }] }],
}
function board(name: string): ContractSnapshot {
	const c = fixtureContract()
	c.values = { ...c.values, ...structuredClone(LOGGER_DESIGN), links: boardLinks(spec, name) }
	for (const l of c.values.links!) c.values.parts = [...c.values.parts!, { ref: l.connector, role: "connector", ...LINK_CONNECTOR }]
	for (let next = linkProposal(c); next; next = linkProposal(c)) (c.values as Record<string, unknown>)[next.field] = next.value
	return c
}

test("link.h prints through the console, so LINK lines reach the USB port too", () => {
	const h = linkHeader(board("b"))
	assert.match(h, /Log\.printf\("LINK %s reading from a:/)
	assert.doesNotMatch(h, /\bSerial\.(print|printf|println)\(/)
})

test("the bench plan reads the product firmware on USB: SENSOR OK alone, real LINK lines at the end, no 'can't pass yet'", () => {
	const p = benchPlan(spec, { a: board("a"), b: board("b") }, { a: "fw/a", b: "fw/b" })
	const text = p.steps.flatMap((s) => [...s.do, ...s.pass]).join("\n")
	assert.doesNotMatch(text, /can't pass on a real board yet|UART0/)
	assert.ok(p.steps[0].pass.some((l) => /a: its USB port prints `SENSOR OK/.test(l)), p.steps[0].pass.join("\n"))
	assert.ok(p.steps.at(-1)!.pass.some((l) => /b prints `LINK L1 reading from a: …` with real values/.test(l)))
})
