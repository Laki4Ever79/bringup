// CAD-style rulers for the PCB stage: mm along the top (x) and left (y), origin at the board's bottom-left corner,
// y up, tracking pcb-view's zoom and pan. Pure helpers; the page draws them.
// Plain ES module with no dependencies: the page imports it from /rulers.js and the tests import it in Node.

const TARGET_PX = 80

// The labelled step: 1, 2 or 5 × 10ⁿ mm, whichever puts labels nearest 80 px apart (so about 50–130 px), and the
// minor step between them (fifths of a 1 or 5, quarters of a 2).
export function tickStep(pxPerMm) {
	const want = TARGET_PX / pxPerMm
	const p = Math.floor(Math.log10(want))
	let best = null
	for (const e of [p - 1, p, p + 1]) {
		for (const d of [1, 2, 5]) {
			const step = d * 10 ** e
			const off = Math.abs(Math.log((step * pxPerMm) / TARGET_PX))
			if (!best || off < best.off) best = { off, d, step }
		}
	}
	const clean = (x) => Number(x.toPrecision(6))
	return { major: clean(best.step), minor: clean(best.step / (best.d === 2 ? 4 : 5)) }
}

// mm ↔ px for a pcb-view view box [x, y, w, h] (mm, svg y = −board y) drawn in width × height px, with the
// ruler origin at `origin` (the board's bottom-left corner, board coordinates).
// The SVG's default preserveAspectRatio (xMidYMid meet): one scale for both axes, the view centred.
export function axisMap({ view, width, height, origin }) {
	const k = Math.min(width / view[2], height / view[3])
	const ox = (width - view[2] * k) / 2
	const oy = (height - view[3] * k) / 2
	return {
		pxPerMm: k,
		xPx: (mm) => ox + (origin.x + mm - view[0]) * k,
		yPx: (mm) => oy + (-(origin.y + mm) - view[1]) * k,
		xMm: (px) => (px - ox) / k + view[0] - origin.x,
		yMm: (px) => -((px - oy) / k + view[1]) - origin.y,
	}
}

const label = (mm) => String(Number(mm.toFixed(6)))

// Every minor tick in [from, to] mm; the ones on a major step are major and labelled.
export function rulerTicks(from, to, { major, minor }) {
	const out = []
	const per = Math.round(major / minor)
	for (let k = Math.ceil(from / minor - 1e-9); k * minor <= to + 1e-9; k++) {
		const mm = Number((k * minor).toFixed(6))
		const isMajor = ((k % per) + per) % per === 0
		out.push(isMajor ? { mm, major: true, label: label(mm) } : { mm, major: false })
	}
	return out
}
