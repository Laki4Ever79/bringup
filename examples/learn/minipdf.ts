// A tiny PDF writer for test fixtures: pages of Helvetica text and straight lines, no dependencies. Coordinates are
// points from the page's top left (612 × 792, US Letter), converted to PDF's bottom-left origin here.

export interface MiniPage {
	text?: { s: string; x: number; y: number; size?: number }[]
	lines?: { x1: number; y1: number; x2: number; y2: number }[]
	circles?: { cx: number; cy: number; r: number }[]
}

const W = 612
const H = 792
const pdfString = (s: string) => `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`

// Latin-1 only: the fixtures use plain ASCII plus a few WinAnsi characters (Ø is 0xD8 there).
function encode(s: string): string {
	return s.replace(/Ø/g, "\\330").replace(/~/g, "~")
}

function content(p: MiniPage): string {
	const ops: string[] = []
	for (const l of p.lines ?? []) ops.push(`${l.x1} ${H - l.y1} m ${l.x2} ${H - l.y2} l S`)
	for (const c of p.circles ?? []) {
		// Four Bézier arcs approximate a circle.
		const k = 0.5523 * c.r
		const x = c.cx
		const y = H - c.cy
		ops.push(`${x + c.r} ${y} m ${x + c.r} ${y + k} ${x + k} ${y + c.r} ${x} ${y + c.r} c ${x - k} ${y + c.r} ${x - c.r} ${y + k} ${x - c.r} ${y} c ${x - c.r} ${y - k} ${x - k} ${y - c.r} ${x} ${y - c.r} c ${x + k} ${y - c.r} ${x + c.r} ${y - k} ${x + c.r} ${y} c S`)
	}
	for (const t of p.text ?? []) ops.push(`BT /F1 ${t.size ?? 10} Tf ${t.x} ${H - t.y} Td ${encode(pdfString(t.s))} Tj ET`)
	return ops.join("\n")
}

export function miniPdf(pages: MiniPage[]): Buffer {
	const objs: string[] = []
	// 1 catalog, 2 pages, 3 font, then per page: page object, content stream.
	const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")
	objs.push("<< /Type /Catalog /Pages 2 0 R >>")
	objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`)
	objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
	for (const [i, p] of pages.entries()) {
		const stream = content(p)
		objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`)
		objs.push(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`)
	}
	let out = "%PDF-1.4\n"
	const offsets: number[] = []
	for (const [i, o] of objs.entries()) {
		offsets.push(Buffer.byteLength(out, "latin1"))
		out += `${i + 1} 0 obj\n${o}\nendobj\n`
	}
	const xref = Buffer.byteLength(out, "latin1")
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`
	out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
	return Buffer.from(out, "latin1")
}
