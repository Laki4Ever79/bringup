// `bringup system <system.json>` (docs/system.md): each board runs as its own Bringup design (a separate process: one
// Mozaik runtime per process, so each board works exactly as it does alone), in parallel. The system hands each board
// its links, waits for the boards to settle, checks the links between them, and sends each finding to the board that
// can fix it, as a change request. It ends when every board has settled with its links and the checks are clean.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ContractSnapshot } from "../contract/types.ts"
import { appendRequest } from "../runner/requests.ts"
import { readTrace } from "../runner/ripple.ts"
import { startRunProcess, type RunProcess } from "../runner/spawn-run.ts"
import { systemChecks, type SystemFinding } from "./checks.ts"
import { boardLinks } from "./derive.ts"
import { linkTests as runLinkTests, type LinkTest } from "./linktest.ts"
import { cableMarkdown, systemReport, wirevizYaml } from "./outputs.ts"
import type { SystemSpec } from "./spec.ts"

export interface SystemRunOptions {
	spec: SystemSpec
	outDir: string
	mock: boolean
	// Flags for each board's run, e.g. --no-hardware, --no-review.
	boardArgs?: string[]
	timeoutMs?: number
	// How many times a finding may go back to the boards before the system gives up.
	maxRounds?: number
	pollMs?: number
	start?: typeof startRunProcess
	// Run each UART link's two firmwares in QEMU, joined by a virtual cable, once the checks pass (linktest.ts).
	linkTest?: { root: string; pio: string | null; qemu: boolean }
}

export interface SystemResult {
	ok: boolean
	findings: SystemFinding[]
	linkTests: LinkTest[]
	reportPath: string
}

export const boardDir = (outDir: string, board: string) => join(outDir, "boards", board)

// A board's newest settled contract: the contract.json its run wrote at its last settle, once that settle is newer than
// `after` (the trace length when the system last asked it for something).
function settledContract(dir: string, after: number): ContractSnapshot | null {
	const trace = readTrace(dir)
	const last = trace.map((e, i) => ({ e, i })).filter(({ e }) => e.type === "design.settled").at(-1)
	if (!last || last.i < after || !(last.e.payload as { settled?: boolean }).settled) return null
	const path = join(dir, "contract.json")
	return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ContractSnapshot) : null
}

export async function runSystem(o: SystemRunOptions): Promise<SystemResult> {
	const { spec, outDir } = o
	const start = o.start ?? startRunProcess
	mkdirSync(outDir, { recursive: true })
	writeFileSync(join(outDir, "system.json"), JSON.stringify(spec, null, 2))
	const procs: RunProcess[] = []
	const asked = new Map<string, number>() // board → trace length when last asked; its next settle must come after
	const sent: { board: string; text: string }[] = []
	const designed = spec.boards.filter((b) => b.brief)
	for (const b of designed) {
		const dir = boardDir(outDir, b.name)
		mkdirSync(dir, { recursive: true })
		// The links go in before the run starts, so the board's agents design them in from the first draft.
		const links = boardLinks(spec, b.name)
		if (links.length) {
			const text = `System ${spec.name}: this board's links (${links.map((l) => `${l.id} ${l.kind.toUpperCase()} to ${l.peer}`).join(", ")})`
			appendRequest(dir, text, undefined, links)
			sent.push({ board: b.name, text })
		}
		asked.set(b.name, 0)
		procs.push(start({ briefPath: b.brief!, mock: o.mock, outDir: dir, extraArgs: [...(o.boardArgs ?? []), "--stay"] }))
	}
	const contractsNow = (): Record<string, ContractSnapshot | undefined> =>
		Object.fromEntries(
			spec.boards.map((b) => {
				if (b.run) return [b.name, existsSync(join(b.run, "contract.json")) ? JSON.parse(readFileSync(join(b.run, "contract.json"), "utf8")) : undefined]
				return [b.name, settledContract(boardDir(outDir, b.name), asked.get(b.name) ?? 0) ?? undefined]
			}),
		)
	let tests: LinkTest[] = []
	const write = (contracts: Record<string, ContractSnapshot | undefined>, findings: SystemFinding[], status: string) => {
		writeFileSync(join(outDir, "cable.md"), cableMarkdown(spec, contracts))
		writeFileSync(join(outDir, "cable.yml"), wirevizYaml(spec, contracts))
		writeFileSync(join(outDir, "system-findings.json"), JSON.stringify(findings, null, 2))
		writeFileSync(join(outDir, "system-report.md"), systemReport(spec, contracts, findings, status, sent, tests))
	}

	const deadline = Date.now() + (o.timeoutMs ?? 30 * 60_000)
	const maxRounds = o.maxRounds ?? 3
	const handed = new Set<string>()
	let rounds = 0
	let findings: SystemFinding[] = []
	let ok = false
	try {
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, o.pollMs ?? 2000))
			const contracts = contractsNow()
			// Wait until every board has settled since it was last asked for something.
			if (spec.boards.some((b) => !contracts[b.name])) continue
			findings = systemChecks(spec, contracts)
			const real = findings.filter((f) => f.kind !== "link-pending")
			if (findings.length === 0) {
				if (o.linkTest) tests = await runLinkTests(spec, contracts, o.linkTest, outDir)
				ok = tests.every((t) => t.passed || !t.ran)
				write(contracts, findings, ok ? "settled: every board settled with its links, and the checks between them pass" : "UNSETTLED: a link test failed")
				break
			}
			// Each finding goes once to the boards that can fix it (a fixed board can't be asked: it is reported).
			const fresh = real.filter((f) => !handed.has(f.message))
			if (fresh.length === 0 || rounds >= maxRounds) {
				write(contracts, findings, rounds >= maxRounds ? `UNSETTLED: findings remain after ${maxRounds} rounds` : "UNSETTLED: findings no board can fix")
				break
			}
			rounds++
			for (const f of fresh) {
				handed.add(f.message)
				for (const board of f.boards.filter((n) => designed.some((b) => b.name === n))) {
					const dir = boardDir(outDir, board)
					const text = `System check (${spec.name}, link ${f.link}): ${f.message}`
					asked.set(board, readTrace(dir).length)
					appendRequest(dir, text)
					sent.push({ board, text })
				}
			}
			write(contracts, findings, `round ${rounds}: findings sent to the boards`)
		}
		if (!ok && Date.now() >= deadline) write(contractsNow(), findings, "UNSETTLED: timed out")
	} finally {
		for (const p of procs) p.kill()
		await Promise.all(procs.map((p) => p.done))
	}
	return { ok, findings, linkTests: tests, reportPath: join(outDir, "system-report.md") }
}
