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
