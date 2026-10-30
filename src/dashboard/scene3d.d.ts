type Vec3 = [number, number, number] | number[]

export function heightFor(ref: string, role?: string): number
export function boxTris(min: Vec3, max: Vec3): number[]
export function boardMesh(
	circuit: any[],
	parts?: { ref: string; role?: string }[],
): { positions: Float32Array; colors: number[][]; refs: (string | null)[]; kinds: ("slab" | "pad" | "part")[]; bounds: { min: number[]; max: number[] } }
export function placeBoardInCase(caseTris: Float32Array, board: { min: number[]; max: number[] }, boardZ?: number): [number, number, number]
export function enclosureFrame(spec: any): { boardZ: number; lidTopZ: number; postOuter: number } | null
export function assembleLid(lidTris: Float32Array, lidTopZ: number): Float32Array
export function postTris(standoffs: { xMm: number; yMm: number; holeMm?: number }[] | null | undefined, z0: number, z1: number, outer: number): number[]

export interface Camera { eye: number[]; forward: number[]; right: number[]; up: number[]; fov: number }
export function orbitCamera(o: { yaw: number; pitch: number; distance: number; target: Vec3; fov?: number }): Camera
export function project(cam: Camera, p: Vec3, width: number, height: number): [number, number, number]
export function triNormal(tris: Float32Array, i: number): number[]
export function shade(rgb: number[], normal: number[], light: number[]): number[]
export function tiltMatrix(pitch: number, roll: number): number[]
export function applyTilt(m: number[], p: Vec3, centre: Vec3): number[]

export interface SceneView {
	update(input: { caseStl?: ArrayBuffer | null; lidStl?: ArrayBuffer | null; enclosure?: { spec: any; standoffs: any[] | null } | null; circuit?: any[] | null }): void
	setExplode(t: number): void
	highlight(ref: string | null): void
	setParts(parts: { ref: string; role?: string }[]): void
	setOrientation(pitchRad: number | null, rollRad: number | null): void
	// rgb lights the part; null shows it dark; ref null stops mirroring.
	setLit(ref: string | null, rgb: [number, number, number] | null): void
}
export function mountScene(el: HTMLElement, opts?: { onHover?(ref: string | null): void; parts?: { ref: string; role?: string }[] }): SceneView
export interface PaintItem {
	kind: string
	depth: number
	nz: number
	z: number
}
export function paintOrder<T extends PaintItem>(items: T[], opts: { boardDepth: number; boardZ: number; above: boolean }): T[]
