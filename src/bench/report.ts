import { existsSync, readFileSync } from "node:fs"
import type { Payloads } from "../events.ts"

interface Line {
	type: string
	payload: any
}

const SOURCE_LABEL = {
	real: "real board",
	replay: "REPLAY of a recorded session (not this run's firmware)",
	fake: "fake bench (simulated board and meter)",
} as const

const sig = (x: number) => Number(x.toPrecision(3))

// report.md's "Bring-up" section, from the trace's bench events: the last flash, the last verdict's checks, the last
// measurement, and what change control did with the bench's rails proposal.
export function bringupSection(tracePath: string): string[] {
	const trace: Line[] = existsSync(tracePath)
		? readFileSync(tracePath, "utf8")
				.split("\n")
				.filter((l) => l.trim())
				.flatMap((l) => {
					try {
						return [JSON.parse(l) as Line]
					} catch {
						return []
					}
				})
		: []
	const last = <T extends keyof Payloads>(type: T): Payloads[T] | undefined => trace.findLast((e) => e.type === type)?.payload
	const connected = last("bench.connected")
	const flashed = last("bench.flashed")
	const verdict = last("bench.verdict")
	const measured = last("bench.measured")
	const out = ["## Bring-up", ""]
	if (connected) out.push(`Bench: ${SOURCE_LABEL[connected.source]}${connected.meter ? "" : ", no meter (no fixture or INA226)"}.`)
	if (!flashed) return [...out, "No firmware flashed: nothing flashed before the run ended (the bench waits for the first settle).", ""]
	if (verdict) out.push(`Verdict: ${verdict.pass ? "pass" : "FAIL"} at firmware rev ${verdict.revision}${verdict.source === "replay" ? " (REPLAY)" : ""}.`)
	out.push(
		flashed.ok
			? `- Flash: rev ${flashed.revision} ${flashed.simulated ? "simulated (replay)" : `flashed in ${sig(flashed.ms / 1000)} s`}`
			: `- Flash: rev ${flashed.revision} flash failed at ${flashed.stage ?? "?"}: ${flashed.error ?? ""}`,
	)
	// What the person at the desk was asked to do, and whether they did.
	for (const e of trace.filter((x) => x.type === "bench.instruction" && x.payload.state !== "waiting")) {
		const p = e.payload as Payloads["bench.instruction"]
		out.push(`- Asked the person${p.revision !== null ? ` (rev ${p.revision})` : ""}: ${p.text}: ${p.state === "done" ? "done" : "nobody did it within 180 s"}`)
	}
	for (const c of verdict?.checks ?? []) out.push(c.skipped ? `- ${c.name}: not checked, ${c.detail}` : `- ${c.name}: ${c.pass ? "ok" : "FAIL"}, ${c.detail}`)
	if (measured) {
		const tag = measured.source === "real" ? "" : ` (${measured.source.toUpperCase()}`
		out.push(
			`- Measured${tag ? `${tag}, rev ${measured.revision})` : ` at rev ${measured.revision}`}: ${sig(measured.averageMa)} mA on ${measured.rail ?? "an unattributed rail"} ` +
				`from ${measured.cycles} wakes of ${Math.round(measured.awakeMs)} ms, ${Math.round(measured.chargeUc)} µC each, over the contract's period plus ${measured.sleepUa} µA asleep; ` +
				`estimate ${measured.estimateMa === null ? "none" : `${sig(measured.estimateMa)} mA`}. The dev board's own floor ${sig(measured.floorMa)} mA is excluded.`,
		)
		const proposal = trace.find((e) => e.type === "change.proposed" && e.payload.by === "bench" && e.payload.field === "rails")
		if (measured.source !== "real") out.push("- Contract: never proposed (only a real board's measurement goes to the contract).")
		else if (proposal) {
			const resolved = trace.find((e) => e.type === "change.resolved" && e.payload.proposalId === proposal.payload.proposalId)?.payload
			out.push(
				resolved
					? `- Contract: the measured average was ${resolved.approved ? "approved" : "rejected"} by ${resolved.decidedBy.join(" and ")} (${resolved.reason}).`
					: "- Contract: the measured average is waiting for the architect.",
			)
		} else out.push("- Contract: not proposed (within 10 % of the contract, or not attributable to one rail).")
	} else if (connected && !connected.meter) out.push("- Measured: no meter, so battery life is still the estimate.")
	return [...out, ""]
}
