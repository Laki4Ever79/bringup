import { DEFAULT_I2C_KHZ, specErrors, type SystemSpec } from "./spec.ts"
import { CABLE_PF_PER_M, i2cCableLimit, PULLUP_OHM } from "./checks.ts"

// A system plan: what the architect proposes from a sentence and the user edits before Build. `spec` is the system spec
// the existing system run builds; its boards' briefs are "briefs/<name>.md" relative to the plan folder, with the text
// in `briefs`. `layout` is the plan drawing's card positions (px), not where boards sit physically.
export interface Plan {
	id: string
	version: number
	sentence: string
	spec: SystemSpec
	briefs: Record<string, string>
	why: string
	offBoard: { name: string; attachesTo: string }[]
	cantBuild: { what: string; reason: string }[]
	layout: Record<string, { x: number; y: number }>
	optional: string[]
	spendUsd: number | null
}

export interface PlanIssue {
	target: { board?: string; link?: string }
	message: string
}

const hex = (a: number) => `0x${a.toString(16).padStart(2, "0")}`

// The checks that need no build: plain code, no model call, fast enough to run on every drag (spec §2).
export function planChecks(p: Plan): PlanIssue[] {
	const s = p.spec
	const out: PlanIssue[] = specErrors(s).map((message) => {
		const link = /^link ([A-Z][A-Z0-9]*):/.exec(message)?.[1]
		const board = /^board ([\w-]+):/.exec(message)?.[1]
		return { target: link ? { link } : board ? { board } : {}, message }
	})
	for (const b of s.boards) if (b.brief && !p.briefs[b.name]?.trim()) out.push({ target: { board: b.name }, message: `${b.name} has no brief yet: write what it should do` })
	if (s.boards.length > 1)
		for (const b of s.boards)
			if (!s.links.some((l) => l.a.board === b.name || l.b.board === b.name)) out.push({ target: { board: b.name }, message: `${b.name} is connected to nothing: draw a cable to another board, or remove it` })
	for (const l of s.links) {
		if (l.kind !== "i2c" || !l.i2c || !(l.cable?.lengthMm > 0)) continue
		const khz = l.i2c.khz ?? DEFAULT_I2C_KHZ
		// Before a build nobody knows each board's I2C parts: count one device per target (estimate).
		const { maxPf, maxMm } = i2cCableLimit(khz, Object.keys(l.i2c.targets).length)
		if (l.cable.lengthMm > maxMm)
			out.push({ target: { link: l.id }, message: `${l.id}: at ${khz} kHz with ${PULLUP_OHM / 1000}k pull-ups the bus allows about ${Math.round(maxPf)} pF, so about ${Math.round(maxMm)} mm of cable (estimate: ${CABLE_PF_PER_M} pF/m); this cable is ${l.cable.lengthMm} mm. Shorten it, slow the bus, or use UART` })
	}
	// A controller's I2C links share its one bus: two targets can't answer at one address.
	const seen = new Map<string, string>()
	for (const l of s.links) {
		if (l.kind !== "i2c" || !l.i2c) continue
		for (const [board, address] of Object.entries(l.i2c.targets)) {
			const key = `${l.i2c.controller}@${address}`
			const other = seen.get(key)
			if (other && other !== board) out.push({ target: { link: l.id }, message: `${board} and ${other} both answer at ${hex(address)} on ${l.i2c.controller}'s bus: give one another address` })
			else seen.set(key, board)
		}
	}
	return out
}
