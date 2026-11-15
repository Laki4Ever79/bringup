// `bringup system <system.json>` (docs/system.md): each board runs as its own Bringup design (a separate process: one
// Mozaik runtime per process, so each board works exactly as it does alone), in parallel. The system hands each board
// its links, waits for the boards to settle, checks the links between them, and sends each finding to the board that
// can fix it, as a change request. It ends when every board has settled with its links and the checks are clean.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ContractSnapshot } from "../contract/types.ts"
import { assemblyFitError, mergeRequest, withOutlines, type SystemAssembly } from "./assembly.ts"
import type { BoardAssembly } from "../mechanics/assembly.ts"
import { appendRequest, watchJsonl } from "../runner/requests.ts"
import { readTrace } from "../runner/ripple.ts"
import { startRunProcess, type RunProcess } from "../runner/spawn-run.ts"
import { systemChecks, type SystemFinding } from "./checks.ts"
import { boardLinks } from "./derive.ts"
import { linkTests as runLinkTests, type LinkTest } from "./linktest.ts"
import { cableMarkdown, systemReport, wirevizYaml } from "./outputs.ts"
import { benchPlan, benchPlanMarkdown } from "./bench-plan.ts"
import type { SystemLink, SystemSpec } from "./spec.ts"
import { SystemTrace } from "./trace.ts"

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
	linkTest?: { root: string; pio: string | null; qemu: boolean; renode?: boolean }
	// --stay: after the system settles (or stops unsettled) it keeps every board's run up and takes system-level
	// change requests from <out>/system-requests.jsonl until `until` resolves (Ctrl-C, the dashboard stopping it).
	stay?: { until: Promise<unknown> }
}

// A system-level change request (POST /api/systems/:id/requests, or a line appended by hand): a new body for the robot
// (plate, where each board sits) and/or new links. Each goes to the boards it concerns, which then settle again.
export const SYSTEM_REQUESTS = "system-requests.jsonl"
export interface SystemRequest {
	at: string
	text?: string
	assembly?: Partial<SystemAssembly>
	links?: SystemLink[]
}

export interface SystemResult {
	ok: boolean
	findings: SystemFinding[]
	linkTests: LinkTest[]
	reportPath: string
}

// Real system run 2 (9 Nov 2026): the beacon was consistent, built and booted, and ran out of revisions at 25 before its
// review; drafting a link took the rest.
export const SYSTEM_BOARD_MAX_REVISIONS = 40

export const boardDir = (outDir: string, board: string) => join(outDir, "boards", board)

// The board's newest settle, when it ended unsettled since `after`: the system stops rather than wait on it.
function unsettledSince(dir: string, after: number): boolean {
	const trace = readTrace(dir)
	const last = trace.map((e, i) => ({ e, i })).filter(({ e }) => e.type === "design.settled").at(-1)
	return Boolean(last && last.i >= after && !(last.e.payload as { settled?: boolean }).settled)
}

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
	const { outDir } = o
	let spec = o.spec
	const trace = new SystemTrace(outDir)
	const followBoards = () => {
		for (const b of spec.boards.filter((x) => x.brief)) trace.follow(b.name, boardDir(outDir, b.name))
	}
	const start = o.start ?? startRunProcess
	mkdirSync(outDir, { recursive: true })
	writeFileSync(join(outDir, "system.json"), JSON.stringify(spec, null, 2))
	const procs: RunProcess[] = []
	const asked = new Map<string, number>() // board → trace length when last asked; its next settle must come after
	const sent: { board: string; text: string }[] = []
	const designed = spec.boards.filter((b) => b.brief)
	// A robot's boards each get the whole body (its plate, every board's place and outline) and which board they are.
	let assembly: SystemAssembly | undefined = spec.assembly?.body === "chassis" ? spec.assembly : undefined
	// board → what it was last handed about its siblings (as JSON). A board's own entry is left out: its own contract's
	// outline is the truth for itself, so a change there is nothing to tell it.
	const assemblySent = new Map<string, string>()
	const siblingsOf = (a: SystemAssembly, name: string) => JSON.stringify({ ...a, boards: a.boards.filter((x) => x.name !== name) })
	const handAssembly = (name: string): BoardAssembly | undefined => {
		if (!assembly) return undefined
		assemblySent.set(name, siblingsOf(assembly, name))
		return { ...assembly, self: name }
	}
	for (const b of designed) {
		const dir = boardDir(outDir, b.name)
		mkdirSync(dir, { recursive: true })
		// The links go in before the run starts, so the board's agents design them in from the first draft.
		const links = boardLinks(spec, b.name)
		const own = handAssembly(b.name)
		if (links.length) {
			const text = `The engineer's system spec (${spec.name}) amends this board's brief: it must expose ${links.map((l) => `link ${l.id}, ${l.kind.toUpperCase()} to ${l.peer} on its own connector`).join("; ")}. The connector and its opening in the case are required.`
			appendRequest(dir, text, undefined, links, own)
			sent.push({ board: b.name, text })
		} else if (own) {
			appendRequest(dir, `The engineer's system spec (${spec.name}) places this board on the robot's chassis.`, undefined, undefined, own)
		}
		asked.set(b.name, 0)
		// A board in a system drafts its links too (the connector, its edge, its pins): more revisions than a board alone.
		procs.push(start({ briefPath: b.brief!, mock: o.mock, outDir: dir, extraArgs: [...(o.boardArgs ?? []), "--stay", "--max-revisions", String(SYSTEM_BOARD_MAX_REVISIONS)] }))
	}
	const contractsNow = (): Record<string, ContractSnapshot | undefined> =>
		Object.fromEntries(
			spec.boards.map((b) => {
				if (b.run) return [b.name, existsSync(join(b.run, "contract.json")) ? JSON.parse(readFileSync(join(b.run, "contract.json"), "utf8")) : undefined]
				return [b.name, settledContract(boardDir(outDir, b.name), asked.get(b.name) ?? 0) ?? undefined]
			}),
		)
	let tests: LinkTest[] = []
	// Each board's newest contract, settled or not: what the report shows when the system stops early.
	const lastContracts = (): Record<string, ContractSnapshot | undefined> =>
		Object.fromEntries(
			spec.boards.map((b) => {
				const path = join(b.run ?? boardDir(outDir, b.name), "contract.json")
				return [b.name, existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ContractSnapshot) : undefined]
			}),
		)
	// Each board's newest firmware folder (firmware/rev-N), for the bench plan's flash commands; null before its first build.
	const firmwareDirs = (): Record<string, string | null> =>
		Object.fromEntries(
			spec.boards.map((b) => {
				const root = join(b.run ?? boardDir(outDir, b.name), "firmware")
				const revs = existsSync(root) ? readdirSync(root).map((n) => /^rev-(\d+)$/.exec(n)?.[1]).filter((n): n is string => n !== undefined).map(Number) : []
				return [b.name, revs.length ? join(root, `rev-${Math.max(...revs)}`) : null]
			}),
		)
	const write = (contracts: Record<string, ContractSnapshot | undefined>, findings: SystemFinding[], status: string) => {
		writeFileSync(join(outDir, "cable.md"), cableMarkdown(spec, contracts))
		writeFileSync(join(outDir, "cable.yml"), wirevizYaml(spec, contracts))
		const plan = benchPlan(spec, contracts, firmwareDirs())
		writeFileSync(join(outDir, "bench-plan.md"), benchPlanMarkdown(plan))
		writeFileSync(join(outDir, "bench-plan.json"), JSON.stringify(plan, null, 2))
		writeFileSync(join(outDir, "system-findings.json"), JSON.stringify(findings, null, 2))
		writeFileSync(join(outDir, "system-report.md"), systemReport(spec, contracts, findings, status, sent, tests))
		// The same, for the dashboard's system page.
		writeFileSync(join(outDir, "system-state.json"), JSON.stringify({ at: new Date().toISOString(), status, settled: status.startsWith("settled"), findings, linkTests: tests, asked: sent }, null, 2))
	}

	// A settled board's outline replaces the estimate; the new assembly goes to system.json and to every robot board that
	// holds an older one (each board needs its siblings' real outlines for its chassis and mass).
	// With `send` false (the rounds are used up) it only merges and writes system.json, and names the boards left stale.
	// The brief's size limit, from the first board that has a motion field (the robot's main board).
	const limitOf = (contracts: Record<string, ContractSnapshot | undefined>): [number, number] | undefined => Object.values(contracts).find((c) => c?.values.motion?.maxSizeMm)?.values.motion?.maxSizeMm
	const syncAssembly = (contracts: Record<string, ContractSnapshot | undefined>, send: boolean): string[] => {
		const stale: string[] = []
		if (!assembly) return stale
		const built: Record<string, { widthMm: number; heightMm: number }> = {}
		for (const ab of assembly.boards) {
			const o = contracts[ab.name]?.values.outline
			if (o && (ab.outlineSource !== "built" || o.widthMm !== ab.outline.widthMm || o.heightMm !== ab.outline.heightMm)) built[ab.name] = { widthMm: o.widthMm, heightMm: o.heightMm }
		}
		if (Object.keys(built).length > 0) {
			assembly = withOutlines(assembly, built, limitOf(contracts))
			writeFileSync(join(outDir, "system.json"), JSON.stringify({ ...spec, assembly }, null, 2))
		}
		for (const b of designed) {
			if (!assembly.boards.some((ab) => ab.name === b.name)) continue
			if (assemblySent.get(b.name) === siblingsOf(assembly, b.name)) continue
			stale.push(b.name)
			if (!send) continue
			assemblySent.set(b.name, siblingsOf(assembly, b.name))
			const text = `The robot's body (${spec.name}) changed: a board's built outline replaced its estimate.`
			appendRequest(boardDir(outDir, b.name), text, undefined, undefined, { ...assembly, self: b.name })
			sent.push({ board: b.name, text })
		}
		return stale
	}

	const maxRounds = o.maxRounds ?? 3
	let handed = new Set<string>()
	let rounds = 0
	let findings: SystemFinding[] = []
	let ok = false
	// One settle: until every board settled and the checks between them pass, or the system can't get there.
	const settle = async (): Promise<void> => {
		const deadline = Date.now() + (o.timeoutMs ?? 30 * 60_000)
		handed = new Set<string>()
		rounds = 0
		ok = false
		const end = (status: string, contracts: Record<string, ContractSnapshot | undefined>) => {
			write(contracts, findings, status)
			trace.emit({ board: "system", step: "settled", status: status.startsWith("settled") ? "ok" : "failed", detail: status })
		}
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, o.pollMs ?? 2000))
			followBoards()
			const contracts = contractsNow()
			// A board that ended unsettled (stuck, or at its revision cap) won't fix itself: stop and say which.
			const stuck = designed.filter((b) => unsettledSince(boardDir(outDir, b.name), asked.get(b.name) ?? 0)).map((b) => b.name)
			if (stuck.length) {
				// The other boards are given the time to settle (or end unsettled) first, so the written assembly has their real outlines.
				if (designed.some((b) => !stuck.includes(b.name) && !contracts[b.name] && !unsettledSince(boardDir(outDir, b.name), asked.get(b.name) ?? 0))) continue
				// A sibling that did settle still shows its built outline in the written assembly (nothing is sent: the stuck board won't settle on it).
				syncAssembly(contracts, false)
				end(`UNSETTLED: ${stuck.join(" and ")} ended unsettled (see boards/<name>/report.md)`, lastContracts())
				return
			}
			// Wait until every board has settled since it was last asked for something.
			if (spec.boards.some((b) => !contracts[b.name])) continue
			// A re-sent board must settle again before the run can end: its chassis and mass follow the new outlines.
			const resent = syncAssembly(contracts, rounds < maxRounds)
			// Boards that can't sit within the brief's size limit: no board can fix that, so it is named, not retried.
			const fit = assembly ? assemblyFitError(assembly, limitOf(contracts)) : null
			if (fit) {
				findings = [{ kind: "assembly-fit", link: "", message: fit, boards: [] }]
				end(`UNSETTLED: ${fit}`, contracts)
				return
			}
			if (resent.length && rounds >= maxRounds) {
				end(`UNSETTLED: the robot's body changed after ${maxRounds} rounds and was not sent to ${resent.join(", ")}`, contracts)
				return
			}
			if (resent.length) {
				rounds++
				trace.round++
				trace.emit({ board: "system", step: "assembly", status: "started", detail: resent.join(", ") })
				for (const name of resent) asked.set(name, readTrace(boardDir(outDir, name)).length)
				write(contracts, findings, `round ${rounds}: the robot's body sent again to ${resent.join(", ")}`)
				continue
			}
			findings = systemChecks(spec, contracts)
			const real = findings.filter((f) => f.kind !== "link-pending")
			if (findings.length === 0) {
				if (o.linkTest) {
					trace.emit({ board: "system", step: "link", status: "started" })
					tests = await runLinkTests(spec, contracts, o.linkTest, outDir)
					for (const t of tests) trace.emit({ board: "system", step: "link", status: !t.ran ? "not run" : t.passed ? "ok" : "failed", detail: t.link })
				}
				ok = tests.every((t) => t.passed || !t.ran)
				end(ok ? "settled: every board settled with its links, and the checks between them pass" : "UNSETTLED: a link test failed", contracts)
				return
			}
			// Each finding goes once to the boards that can fix it (a fixed board can't be asked: it is reported).
			const fresh = real.filter((f) => !handed.has(f.message))
			if (fresh.length === 0 || rounds >= maxRounds) {
				end(rounds >= maxRounds ? `UNSETTLED: findings remain after ${maxRounds} rounds` : "UNSETTLED: findings no board can fix", contracts)
				return
			}
			rounds++
			trace.round++
			for (const f of fresh) {
				handed.add(f.message)
				for (const board of f.boards.filter((n) => designed.some((b) => b.name === n))) {
					const dir = boardDir(outDir, board)
					const text = `System check (${spec.name}, link ${f.link}): ${f.message}`
					asked.set(board, readTrace(dir).length)
					appendRequest(dir, text)
					sent.push({ board, text })
					trace.emit({ board, step: "request", status: "started", detail: text.slice(0, 200) })
				}
			}
			write(contracts, findings, `round ${rounds}: findings sent to the boards`)
		}
		end("UNSETTLED: timed out", lastContracts())
	}

	// A system-level request: the new body and links go to the boards they concern; those settle again.
	const applyRequest = (r: SystemRequest): string[] => {
		const touched = new Set<string>()
		const beforeLinks = new Map(designed.map((b) => [b.name, JSON.stringify(boardLinks(spec, b.name))]))
		const was = assembly
		const merged = mergeRequest({ ...spec, ...(assembly ? { assembly } : {}) }, { ...r, ...(assembly ? {} : { assembly: undefined }) })
		spec = merged
		if (assembly) assembly = merged.assembly
		// A board is told only when its own view changed: its siblings' places, the plate or the cables (what it was last
		// handed), its own place, or its links.
		if (assembly) {
			const own = (a: SystemAssembly | undefined, n: string) => JSON.stringify(a?.boards.find((x) => x.name === n))
			for (const b of designed) {
				if (!assembly.boards.some((ab) => ab.name === b.name)) continue
				if (assemblySent.get(b.name) !== siblingsOf(assembly, b.name) || own(was, b.name) !== own(assembly, b.name)) touched.add(b.name)
			}
		}
		for (const b of designed) if (beforeLinks.get(b.name) !== JSON.stringify(boardLinks(spec, b.name))) touched.add(b.name)
		writeFileSync(join(outDir, "system.json"), JSON.stringify({ ...spec, ...(assembly ? { assembly } : {}) }, null, 2))
		trace.round++
		if (touched.size === 0) trace.emit({ board: "system", step: "request", status: "ok", detail: "no board's view of the system changed" })
		for (const name of touched) {
			const dir = boardDir(outDir, name)
			const text = `The engineer changed the system (${spec.name})${r.text ? `: ${r.text}` : ""}.`
			const links = beforeLinks.get(name) !== JSON.stringify(boardLinks(spec, name)) ? boardLinks(spec, name) : undefined
			asked.set(name, readTrace(dir).length)
			appendRequest(dir, text, undefined, links, assembly ? handAssembly(name) : undefined)
			sent.push({ board: name, text })
			trace.emit({ board: name, step: "request", status: "started", detail: text.slice(0, 200) })
		}
		return [...touched]
	}

	try {
		await settle()
		if (o.stay) {
			let stopped = false
			void o.stay.until.then(() => (stopped = true))
			const queue: SystemRequest[] = []
			const watcher = watchJsonl<SystemRequest>(outDir, SYSTEM_REQUESTS, (raw) => (raw && typeof raw === "object" && ("assembly" in raw || "links" in raw) ? (raw as SystemRequest) : null), (r) => queue.push(r))
			trace.emit({ board: "system", step: "request", status: "ok", detail: "staying up for system-level changes" })
			// A board edited on its own (a change request on its page) settles again by itself: the system re-checks then, so
			// the cable, the chassis placement and the link tests follow the edit, and a new outline goes to the others.
			const settles = (name: string) => readTrace(boardDir(outDir, name)).filter((e) => e.type === "design.settled").length
			let seen = new Map(designed.map((b) => [b.name, settles(b.name)]))
			try {
				while (!stopped) {
					await new Promise((r) => setTimeout(r, o.pollMs ?? 2000))
					followBoards()
					const r = queue.shift()
					const resettled = designed.filter((b) => settles(b.name) > (seen.get(b.name) ?? 0)).map((b) => b.name)
					if (r) {
						const touched = applyRequest(r)
						if (touched.length) await settle()
					} else if (resettled.length) {
						trace.round++
						trace.emit({ board: "system", step: "request", status: "started", detail: `${resettled.join(", ")} changed on ${resettled.length > 1 ? "their" : "its"} own page: checking the system again` })
						await settle()
					} else continue
					seen = new Map(designed.map((b) => [b.name, settles(b.name)]))
				}
			} finally {
				watcher.close()
			}
		}
	} finally {
		for (const p of procs) p.kill()
		await Promise.all(procs.map((p) => p.done))
	}
	return { ok, findings, linkTests: tests, reportPath: join(outDir, "system-report.md") }
}
