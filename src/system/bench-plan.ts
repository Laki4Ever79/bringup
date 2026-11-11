// The system's bench test plan (docs/system.md, phase 2): what a person does on the bench, in order, to prove a built
// system's boards, cables and links, and what passes. Generated from the spec and the boards' contracts on every check,
// like the cable drawing. bench-plan.json carries the expected lines that py/bench_system.py judges the boards' USB
// output by, the same lines the QEMU link test looks for (linktest.ts).
import type { ContractSnapshot } from "../contract/types.ts"
import { connectorRef } from "./derive.ts"
import type { SystemLink, SystemSpec } from "./spec.ts"

export const BENCH_ENV = "esp32c3_linktest_usb"
// What the link-test firmware sends (main.cpp LINK_TEST: 21.50 °C, 40.25 %RH), as each known field carries it.
const KNOWN: Record<string, number> = { tempCx100: 2150, rhx100: 4025, tempC: 21.5, rh: 40.25, ok: 1 }
// How many times each expected line must arrive while the checker listens, and for how long it listens.
export const BENCH_MIN_LINES = 3
export const BENCH_SECONDS = 15

export function expectedValues(fields: readonly { name: string }[]): Record<string, number> {
	return Object.fromEntries(fields.map((f) => [f.name, KNOWN[f.name] ?? 0]))
}

export interface BenchCheck {
	board: string
	link: string
	message: string
	from: string
	prefix: string
	fields: Record<string, number>
}

export interface BenchStep {
	title: string
	do: string[]
	pass: string[]
}

export interface BenchPlan {
	system: string
	boards: { name: string; firmwareDir: string | null; testKit: boolean }[]
	steps: BenchStep[]
	expect: BenchCheck[]
	minLines: number
	seconds: number
}

const other = (l: SystemLink, board: string) => (l.a.board === board ? l.b.board : l.a.board)

export function benchChecks(spec: SystemSpec): BenchCheck[] {
	return spec.links.flatMap((l) =>
		(l.messages ?? []).map((m) => ({ board: other(l, m.from), link: l.id, message: m.name, from: m.from, prefix: `LINK ${l.id} ${m.name} from ${m.from}:`, fields: expectedValues(m.fields) })),
	)
}

export function benchPlan(spec: SystemSpec, contracts: Record<string, ContractSnapshot | undefined>, firmwareDirs: Record<string, string | null>): BenchPlan {
	const onLink = new Set(spec.links.flatMap((l) => [l.a.board, l.b.board]))
	const boards = spec.boards.filter((b) => onLink.has(b.name)).map((b) => ({ name: b.name, firmwareDir: firmwareDirs[b.name] ?? null, testKit: Boolean(contracts[b.name]?.values.test) }))
	const expect = benchChecks(spec)
	const receivers = [...new Set(expect.map((e) => e.board))]
	const steps: BenchStep[] = []

	// The product firmware prints on UART0 (for QEMU) and on the C3's own USB (templates/fw main.cpp, Console), so a board
	// alone is judged by its USB output, and by its LED.
	const hasSensor = (name: string) => Boolean(contracts[name]?.values.parts?.some((p) => p.role === "sensor"))
	const hasLed = (name: string) => Boolean(contracts[name]?.values.parts?.some((p) => p.role === "led"))
	steps.push({
		title: "Each board alone",
		do: boards.map((b) => (b.testKit ? `${b.name}: run its own production test (its testkit/rev-N/test-plan.md)` : `${b.name}: flash the product firmware (\`pio run -d ${b.firmwareDir ?? "<firmware>"} -t upload\`), USB only, no cable`)),
		pass: boards.flatMap((b) =>
			b.testKit
				? [`${b.name}: every step of its test plan passes`]
				: [
						`${b.name}: its USB port appears on the computer after the flash and a reset, and prints \`bringup rev …\` at boot (115200 baud)`,
						...(hasSensor(b.name) ? [`${b.name}: its USB port prints \`SENSOR OK <°C> C <%RH> %RH\` at each reading, with plausible room values`] : []),
						...(hasLed(b.name) ? [`${b.name}: its LED blinks at each reading`] : []),
					],
		),
	})

	steps.push({
		title: "The cable",
		do: [...spec.links.map((l) => `${l.id}: build it from cable.md (${l.cable.lengthMm} mm, JST SH 4-pin, pin 1 to pin 1), boards unplugged`), "With a meter on continuity (beep), check each wire end to end, then every pair of pins on one end"],
		pass: spec.links.flatMap((l) => [
			`${l.id}: pins 1, 3 and 4 each beep through to the same pin at the other end`,
			l.power ? `${l.id}: pin 2 (VCC) beeps through to pin 2` : `${l.id}: pin 2 (VCC): no wire, no beep (this link carries no power)`,
			`${l.id}: no two pins on one end beep together (no short)`,
		]),
	})

	const powered = spec.links.filter((l) => l.power)
	if (powered.length)
		steps.push({
			title: "Power over the cable",
			do: powered.map((l) => `${l.id}: plug the cable in; USB on ${l.power!.from} only, ${other(l, l.power!.from)} on no USB and no battery`),
			pass: [
				...powered.map((l) => `${l.id}: ${other(l, l.power!.from)}'s ${connectorRef(l)} pin 2 reads 3.2 to 3.4 V against pin 1 on the meter, and ${other(l, l.power!.from)} boots (its LED, or its USB output once plugged)`),
				"The 3.2 to 3.4 V window is an estimate (the regulator's tolerance plus the meter's); the catalog has no accuracy figure for the regulators",
			],
		})

	const i2c = spec.links.filter((l) => l.kind === "i2c")
	steps.push({
		title: "The link",
		do: [
			...boards.map((b) => (b.firmwareDir ? `${b.name}: \`pio run -d ${b.firmwareDir} -e ${BENCH_ENV} -t upload\`` : `${b.name}: no firmware yet; build the design first`)),
			"Plug the cables in; every board on USB. The link-test build sends the known reading (21.50 °C, 40.25 %RH) every half second until reset, and prints what arrives",
			`Run the checker: \`.venv/bin/python py/bench_system.py bench-plan.json ${boards.map((b) => `--port ${b.name}=<port>`).join(" ")}\``,
			...i2c.map((l) => `${l.id} is I2C: QEMU can't join two buses, so this is its only running test`),
		],
		pass: [
			...expect.map((e) => `${e.board} prints \`${e.prefix} ${Object.entries(e.fields).map(([k, v]) => `${k}=${v}`).join(" ")}\` at least ${BENCH_MIN_LINES} times in ${BENCH_SECONDS} s`),
			"No board prints `a frame with an unknown definition`: that means the two boards were built from different message definitions",
		],
	})

	steps.push({
		title: "Pull the cable",
		do: spec.links.map((l) => `${l.id}: with the link test still running, unplug the cable for a few seconds, then plug it back`),
		pass: [`${receivers.join(", ") || "The receivers"}: the LINK lines stop while it is out and come back after: they really came over the cable`],
	})

	steps.push({
		title: "The product firmware",
		do: [...boards.map((b) => `${b.name}: flash the product firmware (\`pio run -d ${b.firmwareDir ?? "<firmware>"} -t upload\`)`), "Keep every receiving board on USB: the product firmware deep-sleeps, and a receiver hears a link only while it is awake (USB keeps it awake)", ...spec.links.filter((l) => l.kind === "i2c" && l.i2c).flatMap((l) => [...new Set((l.messages ?? []).map((m) => m.from).filter((f) => f !== l.i2c!.controller))].map((f) => `${f}: keep it on USB too: an I2C target answers the controller only while it is awake, and the product firmware deep-sleeps right after its reading`))],
		pass: [
			...expect.map((e) => `${e.board} prints \`${e.prefix} …\` with real values (not the link test's), each time ${e.from} takes a reading`),
		],
	})

	return { system: spec.name, boards, steps, expect, minLines: BENCH_MIN_LINES, seconds: BENCH_SECONDS }
}

export function benchPlanMarkdown(p: BenchPlan): string {
	const out = [
		`# Bench test: ${p.system}`,
		"",
		"Generated by Bringup from the system spec and the boards' contracts; it changes when they do. Do the steps in order: each one assumes the ones before it passed.",
		"",
		"You need: a multimeter with a continuity beep, one USB cable per board, the cables from cable.md, and a computer that sees every board's USB port at once.",
		"",
		"Firmware folders:",
		...p.boards.map((b) => `- ${b.name}: ${b.firmwareDir ?? "no firmware yet"}`),
		"",
	]
	p.steps.forEach((s, i) => out.push(`## ${i + 1}. ${s.title}`, "", "Do:", ...s.do.map((l) => `- ${l}`), "", "Passes when:", ...s.pass.map((l) => `- ${l}`), ""))
	return out.join("\n")
}
