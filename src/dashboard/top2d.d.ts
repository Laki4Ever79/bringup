import type { TopAssembly, TopLinkIn } from "./top-layout.js"
// caseSpec: the board's enclosure spec.json (outline, wallMm, clearanceMm); its outer footprint is drawn around the board.
export interface TopWorldBoard { name: string; built?: boolean; caseSpec?: { outline?: { widthMm: number; heightMm: number }; wallMm?: number; clearanceMm?: number } | null; outline: { widthMm: number; heightMm: number } | null; circuit?: unknown | null; connectors?: { ref: string; kind: string; edge: string; offsetMm: number }[]; status?: string }
export interface TopChassisSpec {
	motors?: { xMm: number; yMm: number; bodyMm: number[] }[]
	caster?: { xMm: number; wheelMm: number }
	battery?: { xMm: number; yMm: number; sizeMm: number[] }
	drive?: { trackMm: number; axleXMm: number; wheelDiameterMm: number; wheelWidthMm: number }
}
export interface TopView {
	ready: Promise<void>
	setWorld(w: { boards: TopWorldBoard[]; cables?: TopLinkIn[]; assembly?: TopAssembly | null; chassis?: TopChassisSpec | null }): void
	focus(name: string | null, o?: { ms?: number }): Promise<void>
	select(name: string | null, kind?: "board" | "cable"): void
	stats(): { draws: number; boards: number }
	dispose(): void
}
export function mountTop(host: HTMLElement, opts?: { onHover?: (name: string | null, kind: "board" | "cable") => void; onPick?: (name: string, kind: "board" | "cable") => void }): TopView
