// The board's silkscreen as a fab reads it (18 Nov 2026): every report carried KiCad warnings a reviewer sees (real run 20b:
// 42 text_height at 0.7 mm under the 0.8 mm minimum, 9 reference designators on another outline, the edge or a pad).
// Text below the minimum is raised to it; a reference designator that still collides is hidden on the silkscreen (it
// stays in the BOM, the placement file and the assembly drawing).

// JLCPCB's minimum silkscreen text height and the line width that goes with it (and KiCad's board setup default).
export const SILK_TEXT_MIN_MM = 0.8
export const SILK_LINE_MIN_MM = 0.15

// Every silkscreen text's font raised to the minimum height and line width: each font is judged by the nearest layer
// before it in its own text block (a property, fp_text or gr_text: only its at, layer, uuid and effects lie between).
export function raiseSilkText(pcb: string): string {
	return pcb.replace(/\(font\s*\(size ([\d.]+) ([\d.]+)\)(\s*\(thickness ([\d.]+)\))?/g, (all, w: string, h: string, th: string | undefined, t: string | undefined, at: number) => {
		const before = pcb.slice(Math.max(0, at - 400), at)
		const k = before.lastIndexOf("(layer ")
		if (k < 0 || !/^\(layer "?[FB]\.SilkS"?\)/.test(before.slice(k))) return all
		if (/\((footprint|pad|fp_line|fp_rect|fp_poly|fp_circle|gr_line|gr_rect|segment|via) /.test(before.slice(k))) return all
		if (Number(w) >= SILK_TEXT_MIN_MM && Number(h) >= SILK_TEXT_MIN_MM && (t === undefined || Number(t) >= SILK_LINE_MIN_MM)) return all
		const size = `(size ${Math.max(Number(w), SILK_TEXT_MIN_MM)} ${Math.max(Number(h), SILK_TEXT_MIN_MM)})`
		return all.replace(/\(size [\d.]+ [\d.]+\)/, size).replace(/\(thickness [\d.]+\)/, `(thickness ${Math.max(Number(t ?? 0), SILK_LINE_MIN_MM)})`)
	})
}

// The reference designators the DRC found colliding on the silkscreen, hidden.
export function hideReferences(pcb: string, refs: string[]): string {
	let out = pcb
	for (const ref of refs) {
		const esc = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		out = out.replace(new RegExp(`(\\(property "Reference" "${esc}"[\\s\\S]*?\\(effects)`), (m) => (/\(hide yes\)/.test(m) ? m : m.replace(/\(effects$/, "(hide yes)\n\t\t\t(effects")))
	}
	return out
}

// The refs a DRC report names in silkscreen collisions ("Reference field of R5").
export function collidingReferences(violations: { type: string; items?: { description?: string }[] }[]): string[] {
	const kinds = new Set(["silk_overlap", "silk_edge_clearance", "silk_over_copper"])
	const refs = violations.filter((v) => kinds.has(v.type)).flatMap((v) => (v.items ?? []).map((i) => /^Reference field of (\S+)/.exec(i.description ?? "")?.[1]).filter((r): r is string => !!r))
	return [...new Set(refs)]
}

// The footprints whose pin labels ("Footprint text of JS1 (GND)") a DRC report names in silkscreen collisions.
export function collidingLabelFootprints(violations: { type: string; items?: { description?: string }[] }[]): string[] {
	const kinds = new Set(["silk_overlap", "silk_edge_clearance", "silk_over_copper"])
	return [...new Set(violations.filter((v) => kinds.has(v.type)).flatMap((v) => (v.items ?? []).map((i) => /^Footprint text of (\S+) \(/.exec(i.description ?? "")?.[1]).filter((r): r is string => !!r)))]
}

// The footprint blocks of the given refs: start and end offsets in the board file.
function footprintBlocks(pcb: string, refs: string[]): { start: number; end: number }[] {
	const out: { start: number; end: number }[] = []
	const re = /\(footprint "/g
	for (let m = re.exec(pcb); m; m = re.exec(pcb)) {
		let depth = 0
		let i = m.index
		for (; i < pcb.length; i++) {
			if (pcb[i] === "(") depth++
			else if (pcb[i] === ")" && --depth === 0) break
		}
		const text = pcb.slice(m.index, i + 1)
		const ref = /\(property "Reference" "([^"]+)"/.exec(text)?.[1]
		if (ref && refs.includes(ref)) out.push({ start: m.index, end: i + 1 })
		re.lastIndex = i + 1
	}
	return out
}

const editBlocks = (pcb: string, refs: string[], edit: (block: string) => string): string => {
	let out = pcb
	for (const b of footprintBlocks(pcb, refs).reverse()) out = out.slice(0, b.start) + edit(out.slice(b.start, b.end)) + out.slice(b.end)
	return out
}

// Pin labels that collide at the minimum text height alternate sides of the header: by x, every second label's y is
// mirrored about the footprint's origin (odd pins on one side, even on the other).
export function alternatePinLabels(pcb: string, refs: string[]): string {
	return editBlocks(pcb, refs, (block) => {
		const labels = [...block.matchAll(/\(fp_text user "[^"]*"\s*\(at (-?[\d.]+) (-?[\d.]+)/g)].map((m) => ({ at: m.index!, x: Number(m[1]), y: Number(m[2]), text: m[0] }))
		const flip = new Set(labels.sort((a, b) => a.x - b.x).filter((_, i) => i % 2 === 1).map((l) => l.at))
		return block.replace(/\(fp_text user "[^"]*"\s*\(at (-?[\d.]+) (-?[\d.]+)/g, (m, x: string, y: string, at: number) => (flip.has(at) ? m.replace(`(at ${x} ${y}`, `(at ${x} ${-Number(y)}`) : m))
	})
}

// Pin labels with no room on the silkscreen go to the assembly drawing (F.Fab): the board stays readable, the label stays
// in the documents.
export function pinLabelsToFab(pcb: string, refs: string[]): string {
	return editBlocks(pcb, refs, (block) => block.replace(/(\(fp_text user "[^"]*"\s*\(at [^)]*\)\s*\(layer ")([FB])\.SilkS(")/g, "$1$2.Fab$3"))
}
