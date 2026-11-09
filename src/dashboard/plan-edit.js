// Pure edits on a system plan (src/system/plan.ts), shared by the plan screen and the hub. Every function returns a
// new plan; none touches the version (the hub bumps it on save).

// What moved between two plans: board names, then link ids. A board "changed" when its brief changed; a link when
// any of its fields did.
export function planDiff(before, after) {
	const out = { added: [], removed: [], changed: [] }
	const boards = (p) => new Map(p.spec.boards.map((b) => [b.name, p.briefs?.[b.name] ?? ""]))
	const links = (p) => new Map(p.spec.links.map((l) => [l.id, JSON.stringify(l)]))
	for (const [a, b] of [[boards(before), boards(after)], [links(before), links(after)]]) {
		for (const [k, v] of b) if (!a.has(k)) out.added.push(k)
		else if (a.get(k) !== v) out.changed.push(k)
		for (const k of a.keys()) if (!b.has(k)) out.removed.push(k)
	}
	return out
}
