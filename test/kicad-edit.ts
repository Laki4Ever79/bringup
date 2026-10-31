// What a person does in KiCad's PCB editor: drag the right board edge out by dxMm (the Edge.Cuts lines at the
// largest x move together).
export function widenBoard(pcb: string, dxMm: number): string {
	const edge = [...pcb.matchAll(/\(gr_line\s+\(start ([\d.-]+) ([\d.-]+)\)\s+\(end ([\d.-]+) ([\d.-]+)\)[^()]*(?:\([^()]*\)[^()]*)*?\(layer "?Edge\.Cuts"?\)\s*\)/g)]
	const maxX = Math.max(...edge.flatMap((m) => [Number(m[1]), Number(m[3])]))
	let out = pcb
	for (const m of edge) {
		const moved = m[0].replace(/\((start|end) ([\d.-]+) /g, (all, which, x) => (Number(x) === maxX ? `(${which} ${maxX + dxMm} ` : all))
		out = out.replace(m[0], moved)
	}
	return out
}
