export interface TopPoint { x: number; y: number }
export interface TopRect { x: number; y: number; w: number; h: number }
export interface TopBoard { name: string; x: number; y: number; w: number; h: number; rotDeg: number; built: boolean }
export interface TopCable { id: string; kind: string; from: TopPoint; to: TopPoint; path: string; label: string; mid: TopPoint }
export interface TopScene { plate: TopRect | null; boards: TopBoard[]; cables: TopCable[]; bounds: TopRect }
export interface TopAssembly {
	body: string
	plate?: { lengthMm: number; widthMm: number }
	boards: { name: string; xMm: number; yMm: number; rotDeg: number; outline: { widthMm: number; heightMm: number }; outlineSource: string }[]
}
export interface TopBoardIn { name: string; outline?: { widthMm: number; heightMm: number } | null; connectors?: { ref: string; kind: string; edge: string; offsetMm: number }[] }
export interface TopLinkIn { id: string; kind: string; a: { board: string; edge?: string }; b: { board: string; edge?: string }; cable?: { lengthMm: number } }
export function topLayout(assembly: TopAssembly | null | undefined, boards: TopBoardIn[], links: TopLinkIn[]): TopScene
export interface TopShapes { outline: { w: number; h: number }; parts: { x: number; y: number; w: number; h: number; ref: string }[]; pads: TopRect[]; holes: { x: number; y: number; r: number }[] }
export function boardShapes(circuit: unknown): TopShapes
