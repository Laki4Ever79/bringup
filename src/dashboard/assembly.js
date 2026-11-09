// The system page's live assembly: each board's state at a moment, from its run's events (spec §3). A board is
// "empty" until its outline is set, "placed" once it is, "routed" when a board revision is built (parts and traces
// arrive one revision at a time: the run reports no per-part events), "cased" when an enclosure is built. The latest
// consistency check's first problem pulses, with its message cut to 90 characters.

const CAPTION = 90
const cut = (s) => (s.length > CAPTION ? `${s.slice(0, CAPTION - 1)}…` : s)

export function assemblyAt(traces, upTo) {
	const out = {}
	for (const [name, events] of Object.entries(traces)) {
		const b = { outline: null, state: "empty", revision: 0, boardRevision: null, enclosureRevision: null, pulses: [] }
		let checked = null
		for (const e of events) {
			if (upTo && e.at > upTo) break
			const p = e.payload ?? {}
			if (typeof p.revision === "number" && e.type === "contract.changed") b.revision = Math.max(b.revision, p.revision)
			if (e.type === "contract.changed" && p.field === "outline" && p.after?.widthMm) b.outline = { widthMm: p.after.widthMm, heightMm: p.after.heightMm }
			if (e.type === "artifact.ready" && p.kind === "board") b.boardRevision = p.revision
			if (e.type === "artifact.ready" && p.kind === "enclosure") b.enclosureRevision = p.revision
			if (e.type === "consistency.checked") checked = p.violations ?? []
		}
		b.state = b.enclosureRevision !== null ? "cased" : b.boardRevision !== null ? "routed" : b.outline ? "placed" : "empty"
		if (checked?.length) b.pulses = [{ target: { board: name }, caption: cut(String(checked[0].message ?? checked[0].kind ?? "")) }]
		out[name] = b
	}
	return out
}

// The first and last event times over every board: the timeline's ends.
export function timeSpan(traces) {
	let first = null, last = null
	for (const events of Object.values(traces))
		for (const e of events) {
			if (!e.at) continue
			if (first === null || e.at < first) first = e.at
			if (last === null || e.at > last) last = e.at
		}
	return first === null ? null : [first, last]
}
