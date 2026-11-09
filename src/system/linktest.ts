// The system's link test in QEMU (docs/system.md, phase 2): for each UART link, both boards' link-test firmware (their
// own link.h, from their own contracts) boots in its own QEMU, joined by a virtual cable, and each message the link
// carries must arrive with the known reading in it. I2C links can't be joined in QEMU: they are tested on the bench.
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import type { ContractSnapshot } from "../contract/types.ts"
import { buildLinkTestFirmware, prepareFirmware } from "../tools/firmware.ts"
import { mergeFlash, runLinkedPair } from "../tools/emulator.ts"
import type { SystemSpec } from "./spec.ts"

export interface LinkTest {
	link: string
	ran: boolean
	passed: boolean
	detail: string
}

// What the link-test firmware sends (main.cpp LINK_TEST: 21.50 °C, 40.25 %RH), as each known field carries it.
const EXPECTED: Record<string, string> = { tempCx100: "2150", rhx100: "4025", tempC: "21.50", rh: "40.25", ok: "1" }

export async function linkTests(spec: SystemSpec, contracts: Record<string, ContractSnapshot | undefined>, env: { root: string; pio: string | null; qemu: boolean }, outDir: string): Promise<LinkTest[]> {
	const out: LinkTest[] = []
	for (const l of spec.links) {
		if (l.kind !== "uart") {
			out.push({ link: l.id, ran: false, passed: false, detail: "I2C: QEMU can't join two buses; test it on the bench" })
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
		const heard = { [l.a.board]: serial.a, [l.b.board]: serial.b }
		const problems: string[] = []
		for (const m of l.messages ?? []) {
			const to = m.from === l.a.board ? l.b.board : l.a.board
			const line = heard[to].split("\n").find((x) => x.startsWith(`LINK ${l.id} ${m.name} from ${m.from}:`))
			if (!line) {
				problems.push(`${to} never received ${m.name} from ${m.from}`)
				continue
			}
			const wrong = m.fields.filter((f) => !new RegExp(`\\b${f.name}=${EXPECTED[f.name] ?? "0(\\.00)?"}\\b`).test(line))
			if (wrong.length) problems.push(`${to} received ${m.name} with ${wrong.map((f) => f.name).join(", ")} wrong: ${line.trim()}`)
		}
		for (const [board, text] of Object.entries(heard)) if (/unknown definition/.test(text)) problems.push(`${board} dropped a frame built against another definition`)
		out.push({ link: l.id, ran: true, passed: problems.length === 0, detail: problems.length ? problems.join("; ") : `both boards booted in QEMU, joined by a virtual cable; ${(l.messages ?? []).map((m) => `${m.name} arrived from ${m.from} with the known values`).join("; ") || "no messages defined"}` })
	}
	return out
}
