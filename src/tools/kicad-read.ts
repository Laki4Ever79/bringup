// Reads what a person can change in KiCad back into the contract's terms: the outline from Edge.Cuts and each J*/SW*
// footprint as edge@offset. Pure, so a re-saved file, a fixture and a live edit read the same way.
import type { Connector } from "../contract/types.ts"

export interface BoardEdits {
	outline: { widthMm: number; heightMm: number }
	connectors: { ref: string; edge: Connector["edge"]; offsetMm: number }[]
}

type Sexp = string | Sexp[]

// A minimal s-expression reader: lists, quoted strings (with \" escapes) and bare atoms. Formatting doesn't matter.
function parse(text: string): Sexp[] {
	const root: Sexp[] = []
	const stack: Sexp[][] = [root]
	const re = /\s*(?:(\()|(\))|"((?:[^"\\]|\\.)*)"|([^\s()"]+))/gy
	let m: RegExpExecArray | null
	while ((m = re.exec(text)) && m[0] !== "") {
		const top = stack[stack.length - 1]
		if (m[1]) {
			const list: Sexp[] = []
			top.push(list)
			stack.push(list)
		} else if (m[2]) {
			if (stack.length > 1) stack.pop()
		} else top.push(m[3] !== undefined ? m[3].replace(/\\(.)/g, "$1") : m[4])
	}
	return root
}

const head = (e: Sexp): string | undefined => (Array.isArray(e) && typeof e[0] === "string" ? e[0] : undefined)
const child = (e: Sexp[], name: string) => e.find((c) => head(c) === name) as Sexp[] | undefined
const nums = (e: Sexp[] | undefined) => (e ?? []).slice(1).map(Number)

// The generator's frame (src/codegen/circuit.ts): every connector's centre sits 6 mm in from its edge, turned
// left -90, right 90, bottom 0, top 180. KiCad keeps tscircuit's rotation and flips y (it runs down).
const EDGE_OF_ROTATION: Record<number, Connector["edge"]> = { 270: "left", 90: "right", 0: "bottom", 180: "top" }
// How far from its edge a footprint may sit and still count as on the edge its rotation names.
const ON_EDGE_MM = 9

export function readBoardEdits(pcbText: string): BoardEdits {
	const tree = parse(pcbText)
	const board = (tree.find((e) => head(e) === "kicad_pcb") as Sexp[] | undefined) ?? []

	// Bounding box of every top-level drawing on Edge.Cuts (gr_line, gr_rect, gr_arc, gr_poly...).
	const xs: number[] = []
	const ys: number[] = []
	for (const e of board) {
		if (!Array.isArray(e) || !head(e)?.startsWith("gr_") || child(e, "layer")?.[1] !== "Edge.Cuts") continue
		const points = [...["start", "end", "mid"].map((k) => child(e, k)), ...(child(e, "pts") ?? []).filter((p) => head(p) === "xy")]
		for (const p of points) {
			if (!p) continue
			const [x, y] = nums(p as Sexp[])
			xs.push(x)
			ys.push(y)
		}
	}
	if (!xs.length) throw new Error("readBoardEdits: the file has no Edge.Cuts outline")
	const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
	const r = (n: number) => +n.toFixed(3)

	const connectors: BoardEdits["connectors"] = []
	for (const e of board) {
		if (!Array.isArray(e) || head(e) !== "footprint") continue
		const prop = e.find((c) => Array.isArray(c) && ((c[0] === "property" && c[1] === "Reference") || (c[0] === "fp_text" && c[1] === "reference"))) as Sexp[] | undefined
		const ref = prop?.[2]
		if (typeof ref !== "string" || !/^(J|SW)\d/.test(ref)) continue
		const [x, y, rot = 0] = nums(child(e, "at"))
		// Distance in from each edge; offsets run from the bottom-left corner, up along y and right along x.
		const inFrom: Record<Connector["edge"], number> = { left: x - minX, right: maxX - x, bottom: maxY - y, top: y - minY }
		const turned = EDGE_OF_ROTATION[((Math.round(rot) % 360) + 360) % 360]
		const edge = turned && inFrom[turned] <= ON_EDGE_MM ? turned : (Object.keys(inFrom) as Connector["edge"][]).reduce((a, b) => (inFrom[b] < inFrom[a] ? b : a))
		connectors.push({ ref, edge, offsetMm: r(edge === "left" || edge === "right" ? maxY - y : x - minX) })
	}
	return { outline: { widthMm: r(maxX - minX), heightMm: r(maxY - minY) }, connectors }
}
