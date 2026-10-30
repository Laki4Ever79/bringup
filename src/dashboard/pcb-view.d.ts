export const PCB_COLORS: {
	bg: string; board: string; edge: string; copperTop: string; copperBottom: string; pad: string; silk: string
	gnd: string; power: string; accent: string; signals: string[]
}
export function netColor(name: string | null, index: number): string

export interface PcbComponent { id: string; ref: string; layer: "top" | "bottom"; x0: number; y0: number; x1: number; y1: number; cx: number; cy: number }
export interface PcbPad { kind: "smt" | "pth"; ref: string | null; net: string | null; layer: "top" | "bottom" | "both"; shape: string; x: number; y: number; w: number; h: number; holeW?: number; holeH?: number }
export interface PcbTrace { id: string; net: string | null; refs: string[]; segments: { x1: number; y1: number; x2: number; y2: number; width: number; layer: "top" | "bottom" }[] }
export interface CircuitIndex {
	board: { cx: number; cy: number; w: number; h: number; thickness: number; layers: number } | null
	components: PcbComponent[]
	pads: PcbPad[]
	traces: PcbTrace[]
	vias: { x: number; y: number; outer: number; hole: number }[]
	nets: string[]
}
export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

export function circuitIndex(circuit: any[]): CircuitIndex
export function indexBounds(ix: CircuitIndex): Bounds
export function fitTransform(bounds: Bounds, width: number, height: number, padding?: number): { scale: number; apply(x: number, y: number): [number, number] }
export function diffRefs(prev: any[] | null, next: any[] | null): string[]

export interface PcbView {
	update(circuit: any[], changedRefs?: string[]): void
	highlight(ref: string | null): void
	setView(v: "top" | "bottom" | "both"): void
	setParts(parts: { ref: string; mpn?: string; role?: string }[]): void
	setLit(ref: string | null, color: string | null): void
}
export function mountPcb(
	el: HTMLElement,
	opts?: { onHover?(ref: string | null): void; colors?: Record<string, string>; parts?: { ref: string; mpn?: string; role?: string }[] },
): PcbView
