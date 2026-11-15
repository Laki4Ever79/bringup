import type { TopAssembly, TopLinkIn } from "./top-layout.js"
// caseSpec: the board's enclosure spec.json (outline, wallMm, clearanceMm); its outer footprint is drawn around the board.
export interface TopWorldBoard { name: string; built?: boolean; caseSpec?: { outline?: { widthMm: number; heightMm: number }; wallMm?: number; clearanceMm?: number } | null; outline: { widthMm: number; heightMm: number } | null; circuit?: unknown | null; connectors?: { ref: string; kind: string; edge: string; offsetMm: number }[]; status?: string }
export interface TopChassisSpec {
	motors?: { xMm: number; yMm: number; bodyMm: number[] }[]
	caster?: { xMm: number; wheelMm: number }
	battery?: { xMm: number; yMm: number; sizeMm: number[] }
	drive?: { trackMm: number; axleXMm: number; wheelDiameterMm: number; wheelWidthMm: number }
}
export interface TopEditHandlers {
	onDrag?(board: string, xMm: number, yMm: number): void
	onMove?(board: string, xMm: number, yMm: number): void
	onPlateDrag?(lengthMm: number, widthMm: number): void
	onPlate?(lengthMm: number, widthMm: number): void
	onConnect?(a: string, b: string, at: { x: number; y: number }): void
	onRoute?(link: string, points: { xMm: number; yMm: number }[]): void
}
export interface TopView {
	ready: Promise<void>
	setWorld(w: { boards: TopWorldBoard[]; cables?: TopLinkIn[]; assembly?: TopAssembly | null; chassis?: TopChassisSpec | null }): void
	focus(name: string | null, o?: { ms?: number }): Promise<void>
	setBadges(map: Record<string, { text: string; kind: "ok" | "run" | "bad" | "idle"; title?: string } | null | undefined>): void
	select(name: string | null, kind?: "board" | "cable"): void
	// Edit mode (the Top view's editor): handlers in the chassis frame (+x forward, +y left, mm, centres); null leaves it.
	setEdit(handlers: TopEditHandlers | null): void
	// The edit checks' findings, drawn on their items; chips false (during a drag) colours the outlines only.
	setFindings(findings: { target: { board?: string; link?: string; plate?: true }; level: "error" | "warn"; message: string }[], o?: { chips?: boolean }): void
	dragging(): boolean
	stats(): { draws: number; boards: number }
	dispose(): void
}
export function mountTop(host: HTMLElement, opts?: { onHover?: (name: string | null, kind: "board" | "cable") => void; onPick?: (name: string, kind: "board" | "cable") => void }): TopView
