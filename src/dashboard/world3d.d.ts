export interface Camera { yaw: number; pitch: number; distance: number; target: number[] }
export interface WorldBoardIn { name: string; outline: { widthMm: number; heightMm: number } | null }
export interface WorldLinkIn { a: { board: string }; b: { board: string } }
export function autoLayout(boards: WorldBoardIn[], links: WorldLinkIn[], gap?: number): Record<string, { x: number; y: number }>
export function flyCamera(from: Camera, to: Camera, t: number): Camera
export function detailFor(name: string, focused: string | null, count: number): "full" | "box"
export function pickBoard(origin: number[], dir: number[], boxes: { name: string; min: number[]; max: number[] }[]): string | null
export function boardGeometry(b: unknown): { solid: Float32Array | null; shell: Float32Array | null; box: Float32Array; extent: { min: number[]; max: number[] }; robotFrame?: RobotFrame; bought?: true }
export function cableRibbon(a: number[], b: number[], lift?: number, segments?: number, width?: number): { mesh: Float32Array; mid: number[] }
export interface WorldView { ready: Promise<void>; setWorld(w: unknown): void; setBadges(map: Record<string, { text: string; kind: "ok" | "run" | "bad" | "idle"; title?: string } | null | undefined>): void; [k: string]: unknown }
export function mountWorld(host: HTMLElement, opts?: { onHover?: (name: string | null) => void; onPick?: (name: string) => void; onHoverCable?: (id: string | null) => void; onPickCable?: (id: string) => void; still?: string }): WorldView
export interface RobotFrame { shift: number[]; boardZ: number }
export function assemblyPlacement(assembly: { boards: { name: string; xMm: number; yMm: number; rotDeg?: number }[] } | null | undefined, frame: RobotFrame): Record<string, { x: number; y: number; z: number; rotDeg: number }>
export function stackPlaces(boards: { name: string; stackOn?: string; stackMm?: number }[], at: Record<string, { x: number; y: number; z?: number }>): Record<string, { x: number; y: number; z: number }>
export function resolvePlaces(boards: { name: string; at?: { x: number; y: number; z?: number } }[], auto: Record<string, { x: number; y: number }>, on?: { robot: string; places: Record<string, { x: number; y: number; z: number }> } | null): Record<string, { x: number; y: number; z: number }>
export function rotateZ(tris: Float32Array | number[], rotDeg: number): Float32Array
// A rover drawn up to an assembly step (ASSEMBLY_STEPS index) or exploded (mm of lift per step), for a build package.
export const ASSEMBLY_STEPS: string[]
export function roverParts(spec: unknown, chassisTris: Float32Array | null, opts?: { upTo?: number; explode?: number }): { parts: { tris: Float32Array; color: number[]; group: string }[]; boardAt: { xMm: number; yMm: number }; boardZ: number }
