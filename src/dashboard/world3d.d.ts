export interface Camera { yaw: number; pitch: number; distance: number; target: number[] }
export interface WorldBoardIn { name: string; outline: { widthMm: number; heightMm: number } | null }
export interface WorldLinkIn { a: { board: string }; b: { board: string } }
export function autoLayout(boards: WorldBoardIn[], links: WorldLinkIn[], gap?: number): Record<string, { x: number; y: number }>
export function flyCamera(from: Camera, to: Camera, t: number): Camera
export function detailFor(name: string, focused: string | null, count: number): "full" | "box"
export function pickBoard(origin: number[], dir: number[], boxes: { name: string; min: number[]; max: number[] }[]): string | null
export function boardGeometry(b: unknown): { solid: Float32Array | null; shell: Float32Array | null; box: Float32Array; extent: { min: number[]; max: number[] } }
export function cableRibbon(a: number[], b: number[], lift?: number, segments?: number, width?: number): { mesh: Float32Array; mid: number[] }
export function mountWorld(host: HTMLElement, opts?: { onHover?: (name: string | null) => void; onPick?: (name: string) => void; still?: string }): unknown
