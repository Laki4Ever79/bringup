// The system's link test in QEMU (docs/system.md, phase 2): for each UART link, both boards' link-test firmware (their
// own link.h, from their own contracts) boots in its own QEMU, joined by a virtual cable, and each message the link
// carries must arrive with the known reading in it. I2C links can't be joined in QEMU: they are tested on the bench.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import type { ContractSnapshot } from "../contract/types.ts"
import { buildLinkTestFirmware, prepareFirmware } from "../tools/firmware.ts"
import { mergeFlash, runLinkedPair } from "../tools/emulator.ts"
import { envFor } from "../mcu/firmware.ts"
import { mcuProfileOf, type McuProfile } from "../mcu/profile.ts"
import { consoleLines, renodeScript, runRenode } from "../tools/renode.ts"
import type { SystemSpec } from "./spec.ts"
import { expectedValues } from "./bench-plan.ts"

export interface LinkTest {
	link: string
	ran: boolean
	passed: boolean
	detail: string
}

// The fields a received line carries (`name=value`), as numbers.
export function lineValues(line: string): Record<string, number> {
	return Object.fromEntries([...line.matchAll(/\b(\w+)=(-?\d+(?:\.\d+)?)\b/g)].map((m) => [m[1], Number(m[2])]))
}

// The fields whose value isn't the link test's known one (bench-plan.ts expectedValues): printed with two decimals, so
// equal within 0.005.
export function wrongFields(line: string, expected: Record<string, number>): string[] {
	const got = lineValues(line)
	return Object.entries(expected).filter(([k, v]) => got[k] === undefined || Math.abs(got[k] - v) > 0.005).map(([k]) => k)
}

// The UART instance a board's link pins sit on (its profile): the one whose TX signal its <id>_TX pin carries, named as
// Renode names it (usart1). null for a matrix chip or pins no instance carries.
export function linkUartOf(profile: McuProfile, s: ContractSnapshot, linkId: string): string | null {
	const tx = (s.values.pins ?? []).find((p) => p.signal === `${linkId}_TX`)
	const pin = tx && profile.pins.find((p) => p.index === tx.gpio)
	const inst = pin && profile.peripherals.uart.find((i) => i !== profile.console?.instance && pin.signals.includes(`${i}_TX`))
	return inst ? inst.toLowerCase() : null
}

// Two boards whose chips Renode models (STM32, nRF52): both link-test ELFs on one virtual clock, their link UARTs on one
// hub. Each console is read back per machine, as QEMU's files are.
async function renodePair(root: string, boards: { name: string; profile: McuProfile; elf: string; uart: string }[], workDir: string): Promise<{ a: string; b: string } | null> {
	const script = renodeScript(boards.map((b) => ({ name: b.name, profile: b.profile, elf: b.elf, linkUart: b.uart })), { runForS: 6, link: { uart: boards[0].uart } })
	const log = await runRenode(root, script, workDir, 180_000)
	if (log === null) return null
	const [a, b] = boards.map((x) => consoleLines(log, x.profile.sim.consoleUart!, x.name).join("\n"))
	return { a, b }
}

export async function linkTests(spec: SystemSpec, contracts: Record<string, ContractSnapshot | undefined>, env: { root: string; pio: string | null; qemu: boolean; renode?: boolean }, outDir: string): Promise<LinkTest[]> {
	const out: LinkTest[] = []
	for (const l of spec.links) {
		if (l.kind !== "uart") {
			out.push({ link: l.id, ran: false, passed: false, detail: l.kind === "i2c" ? "I2C: QEMU can't join two buses; test it on the bench" : `${l.kind}: no QEMU test for this kind; test it on the bench` })
			continue
		}
		// Which simulator both boards' chips run in: QEMU (ESP32-C3) or Renode (STM32, nRF52). Two different ones can't
		// be joined by a cable here: such a link is tested on the bench.
		const profiles = [l.a.board, l.b.board].map((b) => mcuProfileOf(contracts[b]?.values.parts))
		const sims = profiles.map((p) => (p ? p.sim.backend : "qemu"))
		if (sims[0] !== sims[1] || sims[0] === null) {
			out.push({ link: l.id, ran: false, passed: false, detail: sims[0] === sims[1] ? "no simulator models these boards' chips; test it on the bench" : `the boards' chips run in different simulators (${sims.join(" and ")}); test it on the bench` })
			continue
		}
		if (sims[0] === "renode") {
			if (!env.pio || !env.renode) {
				out.push({ link: l.id, ran: false, passed: false, detail: "needs PlatformIO and Renode" })
				continue
			}
			const boards: { name: string; profile: McuProfile; elf: string; uart: string }[] = []
			let failed = ""
			for (const [k, board] of [l.a.board, l.b.board].entries()) {
				const dir = join(outDir, "linktest", l.id, board)
				mkdirSync(dir, { recursive: true })
				const profile = profiles[k]!
				await prepareFirmware(env.root, dir, contracts[board]!)
				const fw = await buildLinkTestFirmware(env.pio, dir, envFor(profile, "linktest"))
				const uart = linkUartOf(profile, contracts[board]!, l.id)
				if (!fw.ok) failed ||= `${board}'s link-test firmware: ${fw.log.split("\n").slice(-3).join(" ")}`
				else if (!uart) failed ||= `${board}: its ${l.id}_TX pin is on no UART of the ${profile.mpn}`
				else boards.push({ name: board, profile, elf: join(dir, ".pio/build", envFor(profile, "linktest"), "firmware.elf"), uart })
			}
			if (failed) {
				out.push({ link: l.id, ran: false, passed: false, detail: failed })
				continue
			}
			const serial = await renodePair(env.root, boards, join(outDir, "linktest", l.id))
			if (!serial) {
				out.push({ link: l.id, ran: false, passed: false, detail: "Renode not found" })
				continue
			}
			out.push(judge(l, { [l.a.board]: serial.a, [l.b.board]: serial.b }, "Renode"))
			continue
		}
		if (!env.pio || !env.qemu) {
			out.push({ link: l.id, ran: false, passed: false, detail: "needs PlatformIO and QEMU" })
			continue
		}
		const images: string[] = []
		let failed = ""
		for (const board of [l.a.board, l.b.board]) {
			const dir = join(outDir, "linktest", l.id, board)
			mkdirSync(dir, { recursive: true })
			await prepareFirmware(env.root, dir, contracts[board]!)
			const fw = await buildLinkTestFirmware(env.pio, dir)
			const merged = fw.ok ? await mergeFlash(dir, "esp32c3_linktest") : { image: null, log: fw.log }
			if (!merged.image) failed ||= `${board}'s link-test firmware: ${merged.log.split("\n").slice(-3).join(" ")}`
			else images.push(merged.image)
		}
		if (failed) {
			out.push({ link: l.id, ran: false, passed: false, detail: failed })
			continue
		}
		const serial = await runLinkedPair(env.root, images[0], images[1], join(outDir, "linktest", l.id), /LINK TEST DONE/, 120_000)
		if (!serial) {
			out.push({ link: l.id, ran: false, passed: false, detail: "QEMU not found" })
			continue
		}
		out.push(judge(l, { [l.a.board]: serial.a, [l.b.board]: serial.b }, "QEMU"))
	}
	return out
}

// Each message must arrive at the other board with the known values; a frame built against another definition is dropped.
function judge(l: SystemSpec["links"][number], heard: Record<string, string>, sim: string): LinkTest {
		const problems: string[] = []
		for (const m of l.messages ?? []) {
			const to = m.from === l.a.board ? l.b.board : l.a.board
			const line = heard[to].split("\n").find((x) => x.startsWith(`LINK ${l.id} ${m.name} from ${m.from}:`))
			if (!line) {
				problems.push(`${to} never received ${m.name} from ${m.from}`)
				continue
			}
			const wrong = wrongFields(line, expectedValues(m.fields))
			if (wrong.length) problems.push(`${to} received ${m.name} with ${wrong.join(", ")} wrong: ${line.trim()}`)
		}
		for (const [board, text] of Object.entries(heard)) if (/unknown definition/.test(text)) problems.push(`${board} dropped a frame built against another definition`)
		return { link: l.id, ran: true, passed: problems.length === 0, detail: problems.length ? problems.join("; ") : `both boards booted in ${sim}, joined by a virtual cable; ${(l.messages ?? []).map((m) => `${m.name} arrived from ${m.from} with the known values`).join("; ") || "no messages defined"}` }
}
