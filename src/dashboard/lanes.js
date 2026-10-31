// Lane state for the dashboard: one row per participant, updated from trace events.
// Plain ES module with no dependencies: the page imports it from /lanes.js and the tests import it in Node.

export const LANES = [
	{ key: "architect", label: "Architect" },
	{ key: "parts", label: "Part selector" },
	{ key: "firmware", label: "Firmware reviewer" },
	{ key: "reviewer", label: "Brief reviewer" },
	{ key: "build:board", label: "Board" },
	{ key: "build:enclosure", label: "Enclosure" },
	{ key: "build:firmware", label: "Firmware build" },
	{ key: "grounding", label: "Grounding check" },
	{ key: "consistency", label: "Consistency" },
]

const HISTORY = 40

// Same as BUILD_INPUTS and BUILD_REQUIRES in src/agents/builders.ts.
const BUILDS = {
	board: { inputs: ["parts", "pins", "outline", "connectors"], requires: ["outline", "parts", "pins"] },
	enclosure: { inputs: ["outline", "connectors"], requires: ["outline", "connectors"] },
	firmware: { inputs: ["parts", "pins", "behavior", "requirements"], requires: ["parts", "pins"] },
}

// agent.activity phase → lane status
const PHASE_STATUS = { turn: "thinking", thinking: "thinking", tool: "tool", "tool-result": "thinking", held: "held", released: "tool", answer: "idle" }

export function createLanes() {
	// versions: field → latest version (for builders' required fields); agents: agentId → role (for agent.halted);
	// pending: build kind → newest revision it was asked to build
	const lanes = { versions: {}, agents: {}, pending: {} }
	// boot: the firmware build lane's latest QEMU boot (firmware.booted), else null
	for (const l of LANES) lanes[l.key] = { status: "idle", text: "", lastResult: "", at: null, history: [], boot: null }
	return lanes
}

// Updates that count as an outcome for the card's "last result" line.
const RESULT = new Set(["done", "failed"])

// `detail`: the longer story behind a short tile text (the tile's history popover shows it).
function set(lanes, key, status, text, at, result = RESULT.has(status), detail) {
	const lane = lanes[key]
	if (!lane) return []
	lane.status = status
	lane.text = text
	if (result) lane.lastResult = text
	lane.at = at
	lane.history.push(detail ? { status, text, at, detail } : { status, text, at })
	if (lane.history.length > HISTORY) lane.history.splice(0, lane.history.length - HISTORY)
	return [key]
}

const firstLine = (s) => String(s ?? "").split("\n")[0]
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`

// Applies one trace line to the lanes. Returns the keys of the lanes it changed, so the page redraws only those.
export function applyLaneEvent(lanes, e) {
	const p = e.payload ?? {}
	switch (e.type) {
		case "agent.activity": {
			lanes.agents[p.agentId] = p.role
			const result = p.phase === "tool-result" || p.phase === "answer"
			// A loop still winding down after design.settled (its process is exiting) doesn't make the agent busy again.
			if (lanes.ended) return result ? set(lanes, p.role, "idle", p.text, p.at ?? e.at, true) : []
			return set(lanes, p.role, PHASE_STATUS[p.phase] ?? "idle", p.text, p.at ?? e.at, result)
		}
		case "contract.changed": {
			lanes.versions[p.field] = p.version
			const changed = []
			for (const [kind, b] of Object.entries(BUILDS)) {
				if (!b.inputs.includes(p.field)) {
					// Not its input: a finished build is still the current one (the design moved on without it).
					const lane = lanes[`build:${kind}`]
					if (lane.status === "done" && lane.builtRev !== undefined && p.revision > lane.builtRev && /^rev \d+ built$/.test(lane.text)) { lane.text = `rev ${lane.builtRev} · current`; changed.push(`build:${kind}`) }
					continue
				}
				const missing = b.requires.filter((f) => !lanes.versions[f])
				if (missing.length === 0) {
					lanes.pending[kind] = p.revision
					changed.push(...set(lanes, `build:${kind}`, "building", `building rev ${p.revision}…`, e.at))
				}
				else changed.push(...set(lanes, `build:${kind}`, "idle", `needs ${missing.join(", ")}`, e.at))
			}
			if (p.field === "parts" || p.field === "pins") changed.push(...set(lanes, "grounding", "checking", `checking rev ${p.revision}…`, e.at))
			return changed
		}
		case "artifact.ready": {
			// The Rebuilder queues one rebuild for the newest revision; an older build finishing isn't the end.
			const next = lanes.pending[p.kind]
			if (next !== undefined && next > p.revision) return set(lanes, `build:${p.kind}`, "building", `building rev ${next}…`, e.at, false, `rev ${p.revision} built`)
			// The board's DRC rides on its tile (what 04 used to show): clean = no errors; warnings go in the history.
			const drc = p.kind === "board" ? p.drc : null
			lanes[`build:${p.kind}`].builtRev = p.revision
			const text = !drc ? `rev ${p.revision} built` : drc.errors ? `DRC: ${plural(drc.errors, "error")}` : `rev ${p.revision} · DRC clean`
			const detail = drc ? `rev ${p.revision}: ${plural(drc.errors, "error")}, ${plural(drc.warnings ?? 0, "warning")}, ${drc.unconnected ?? 0} unconnected (${drc.rules ?? "default"} rules)` : undefined
			return set(lanes, `build:${p.kind}`, "done", text, e.at, true, detail)
		}
		case "artifact.failed":
			return set(lanes, `build:${p.kind}`, "failed", `rev ${p.revision} failed`, e.at, true, firstLine(p.error))
		case "firmware.booted": {
			// The QEMU boot goes on the build tile's line (what 04 used to show); the build's status stays as it is.
			const lane = lanes["build:firmware"]
			const lines = String(p.serialTail ?? "").split("\n").map((l) => l.trim()).filter(Boolean)
			lane.boot = { ok: p.booted === true, revision: p.revision, bootRevision: p.bootRevision ?? null, lastLine: lines.at(-1) ?? "", tail: p.serialTail ?? "" }
			lane.text = `rev ${p.revision} · QEMU ${lane.boot.ok ? "✓" : "✗"}`
			lane.history.push({ status: lane.status, text: lane.boot.ok ? `boots in QEMU, prints rev ${lane.boot.bootRevision}` : `did not boot (rev ${p.revision}): ${lane.boot.lastLine}`, at: e.at })
			if (lane.history.length > HISTORY) lane.history.splice(0, lane.history.length - HISTORY)
			return ["build:firmware"]
		}
		case "grounding.checked": {
			const n = (p.findings ?? []).length
			return set(lanes, "grounding", n ? "failed" : "done", n ? `rev ${p.revision}: ${n} ungrounded` : `rev ${p.revision}: all grounded`, e.at)
		}
		case "consistency.checked": {
			const v = p.violations ?? []
			const status = v.length ? "failed" : "done"
			return set(lanes, "consistency", status, v.length ? `rev ${p.revision}: ${plural(v.length, "violation")}` : `rev ${p.revision}: consistent`, e.at, RESULT.has(status), v.length ? [...new Set(v.map((x) => x.kind))].join(", ") : undefined)
		}
		case "design.ready":
			return set(lanes, "consistency", "held", "waiting for review", e.at, false, `rev ${p.revision} ready: waiting for the brief review`)
		case "review.completed":
			return set(lanes, "reviewer", p.verdict === "pass" ? "done" : "failed", `${p.verdict} · ${plural((p.findings ?? []).length, "finding")}`, e.at)
		case "design.settled": {
			// The run is over: nobody is still thinking, whatever their last loop event said.
			lanes.ended = true
			const ended = ["architect", "parts", "firmware", "reviewer"].filter((k) => ["thinking", "tool", "held"].includes(lanes[k].status)).flatMap((k) => set(lanes, k, "idle", "run ended", e.at, false))
			return [...ended, ...set(lanes, "consistency", p.settled ? "done" : "failed", p.settled ? `settled at rev ${p.revision}` : `unsettled at rev ${p.revision}`, e.at)]
		}
		case "agent.halted":
			return lanes.agents[p.agentId] ? set(lanes, lanes.agents[p.agentId], "failed", `halted: ${firstLine(p.error)}`, e.at) : []
		default:
			return []
	}
}
