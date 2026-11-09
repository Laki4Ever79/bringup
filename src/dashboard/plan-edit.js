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

const clone = (p) => JSON.parse(JSON.stringify(p))

export function moveBoard(plan, name, x, y) {
	const p = clone(plan)
	p.layout[name] = { x: Math.round(x), y: Math.round(y) }
	return p
}

// A new board, named uniquely (name, name-2, …), placed right of the others.
export function addBoard(plan, name, brief) {
	const p = clone(plan)
	const taken = new Set(p.spec.boards.map((b) => b.name))
	let unique = name, n = 2
	while (taken.has(unique)) unique = `${name}-${n++}`
	p.spec.boards.push({ name: unique, brief: `briefs/${unique}.md` })
	p.briefs[unique] = brief
	const right = Math.max(0, ...Object.values(p.layout).map((l) => l.x))
	p.layout[unique] = { x: right + 260, y: 120 }
	return p
}

// A board and every cable on it.
export function removeBoard(plan, name) {
	const p = clone(plan)
	p.spec.boards = p.spec.boards.filter((b) => b.name !== name)
	p.spec.links = p.spec.links.filter((l) => l.a.board !== name && l.b.board !== name)
	delete p.briefs[name]
	delete p.layout[name]
	p.optional = (p.optional ?? []).filter((n) => n !== name)
	return p
}

export function removeLink(plan, id) {
	const p = clone(plan)
	p.spec.links = p.spec.links.filter((l) => l.id !== id)
	return p
}

// A cable from a to b: UART at 115200, or I2C with a as the controller fitting the pull-ups and b at the first free
// address on a's bus from 0x42. 200 mm long until someone says otherwise. Ids are the smallest free L<n>.
export function connect(plan, a, b, kind) {
	const p = clone(plan)
	const ids = new Set(p.spec.links.map((l) => l.id))
	let n = 1
	while (ids.has(`L${n}`)) n++
	const link = { id: `L${n}`, kind, a: { board: a }, b: { board: b } }
	if (kind === "uart") link.baud = 115200
	else {
		const used = new Set(p.spec.links.filter((l) => l.kind === "i2c" && l.i2c?.controller === a).flatMap((l) => Object.values(l.i2c.targets)))
		let address = 0x42
		while (used.has(address)) address++
		link.i2c = { controller: a, targets: { [b]: address }, pullupsOn: a }
	}
	link.cable = { lengthMm: 200 }
	p.spec.links.push(link)
	return p
}

export function setBrief(plan, name, brief) {
	const p = clone(plan)
	p.briefs[name] = brief
	return p
}
