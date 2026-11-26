// How much of each wide net's routed copper is at the width it needs (circuit.ts routedWidths): a rail that carries
// amps must not be routed at the fab's 0.2 mm default (Freerouting did exactly that before it was handed the widths,
// 26 Nov 2026). Freerouting narrows a wide track only to enter a pin (neck-down), so a short narrow piece at each pad is
// expected; the share of the net's track length at width is what counts.
export interface NetCopper {
	net: string
	needMm: number
	// Track length in mm, all of it and the part at least needMm wide.
	totalMm: number
	atWidthMm: number
}

// The routed segments of a KiCad board (kicad_pcb text): (segment (start x y) (end x y) (width w) (layer …) (net n …)).
// KiCad 9/10 name the net by number in the segment and list the numbers' names at the top; older files by name.
export function netCopper(pcb: string, widths: Map<string, number>): NetCopper[] {
	const names = new Map<string, string>()
	for (const m of pcb.matchAll(/^\s*\(net (\d+) "([^"]*)"\)/gm)) names.set(m[1], m[2])
	const out = new Map<string, NetCopper>([...widths].map(([net, needMm]) => [net, { net, needMm, totalMm: 0, atWidthMm: 0 }]))
	for (const m of pcb.matchAll(/\(segment\s+\(start ([-\d.]+) ([-\d.]+)\)\s+\(end ([-\d.]+) ([-\d.]+)\)\s+\(width ([\d.]+)\)[\s\S]*?\(net (?:(\d+)|"([^"]*)")/g)) {
		const net = m[6] !== undefined ? names.get(m[6]) : m[7]
		const row = net ? out.get(net) : undefined
		if (!row) continue
		const len = Math.hypot(Number(m[3]) - Number(m[1]), Number(m[4]) - Number(m[2]))
		row.totalMm += len
		if (Number(m[5]) + 1e-6 >= row.needMm) row.atWidthMm += len
	}
	return [...out.values()]
}

// The share of a wide net's track that may be narrower (the neck-downs into pins): an ESTIMATE of what a short rail run
// leaves at its pads, to be tightened from routed boards.
export const NECKDOWN_SHARE_MAX = 0.25
export function narrowNets(rows: NetCopper[]): NetCopper[] {
	return rows.filter((r) => r.totalMm > 0 && (r.totalMm - r.atWidthMm) / r.totalMm > NECKDOWN_SHARE_MAX)
}
