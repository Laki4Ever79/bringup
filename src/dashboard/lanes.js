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

// Same as BUILD_REQUIRES in src/agents/builders.ts, and the builders' input fields.
const BUILDS = {
	board: { inputs: ["parts", "pins", "outline", "connectors"], requires: ["outline", "parts", "pins"] },
	enclosure: { inputs: ["outline", "connectors"], requires: ["outline", "connectors"] },
	firmware: { inputs: ["parts", "pins"], requires: ["parts", "pins"] },
}

// agent.activity phase → lane status
const PHASE_STATUS = { turn: "thinking", thinking: "thinking", tool: "tool", "tool-result": "thinking", held: "held", released: "tool", answer: "idle" }

export function createLanes() {
	// versions: field → latest version (for builders' required fields); agents: agentId → role (for agent.halted);
	// pending: build kind → newest revision it was asked to build
	const lanes = { versions: {}, agents: {}, pending: {} }
	for (const l of LANES) lanes[l.key] = { status: "idle", text: "", at: null, history: [] }
	return lanes
}

function set(lanes, key, status, text, at) {
	const lane = lanes[key]
	if (!lane) return []
	lane.status = status
	lane.text = text
	lane.at = at
	lane.history.push({ status, text, at })
	if (lane.history.length > HISTORY) lane.history.splice(0, lane.history.length - HISTORY)
	return [key]
}

const firstLine = (s) => String(s ?? "").split("\n")[0]
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`

// Applies one trace line to the lanes. Returns the keys of the lanes it changed, so the page redraws only those.
export function applyLaneEvent(lanes, e) {
	const p = e.payload ?? {}
	switch (e.type) {
		case "agent.activity":
			lanes.agents[p.agentId] = p.role
			return set(lanes, p.role, PHASE_STATUS[p.phase] ?? "idle", p.text, p.at ?? e.at)
		case "contract.changed": {
			lanes.versions[p.field] = p.version
			const changed = []
			for (const [kind, b] of Object.entries(BUILDS)) {
				if (!b.inputs.includes(p.field)) continue
				const missing = b.requires.filter((f) => !lanes.versions[f])
				if (missing.length === 0) {
					lanes.pending[kind] = p.revision
					changed.push(...set(lanes, `build:${kind}`, "building", `building rev ${p.revision}…`, e.at))
				}
				else changed.push(...set(lanes, `build:${kind}`, "idle", `waiting for ${missing.join(", ")}`, e.at))
			}
			if (p.field === "parts" || p.field === "pins") changed.push(...set(lanes, "grounding", "checking", `checking rev ${p.revision}…`, e.at))
			return changed
		}
		case "artifact.ready": {
			// The Rebuilder queues one rebuild for the newest revision; an older build finishing isn't the end.
			const next = lanes.pending[p.kind]
			if (next !== undefined && next > p.revision) return set(lanes, `build:${p.kind}`, "building", `rev ${p.revision} built · building rev ${next}…`, e.at)
			return set(lanes, `build:${p.kind}`, "done", `rev ${p.revision} built`, e.at)
		}
		case "artifact.failed":
			return set(lanes, `build:${p.kind}`, "failed", `rev ${p.revision} failed: ${firstLine(p.error)}`, e.at)
		case "grounding.checked": {
			const n = (p.findings ?? []).length
			return set(lanes, "grounding", n ? "failed" : "done", n ? `rev ${p.revision}: ${plural(n, "ungrounded claim")}` : `rev ${p.revision}: every part and pin grounded`, e.at)
		}
		case "consistency.checked": {
			const v = p.violations ?? []
			return set(lanes, "consistency", v.length ? "failed" : "done", v.length ? `rev ${p.revision}: ${plural(v.length, "violation")} (${[...new Set(v.map((x) => x.kind))].join(", ")})` : `rev ${p.revision}: consistent`, e.at)
		}
		case "design.ready":
			return set(lanes, "consistency", "held", `rev ${p.revision} ready: waiting for the brief review`, e.at)
		case "review.completed":
			return set(lanes, "reviewer", p.verdict === "pass" ? "done" : "failed", `review ${p.verdict}: ${plural((p.findings ?? []).length, "finding")}`, e.at)
		case "design.settled":
			return set(lanes, "consistency", p.settled ? "done" : "failed", p.settled ? `settled at rev ${p.revision}` : `stopped unsettled at rev ${p.revision}`, e.at)
		case "agent.halted":
			return lanes.agents[p.agentId] ? set(lanes, lanes.agents[p.agentId], "failed", `halted: ${firstLine(p.error)}`, e.at) : []
		default:
			return []
	}
}
