type Vec3 = [number, number, number] | number[]

export function heightFor(ref: string, role?: string): number
export function boxTris(min: Vec3, max: Vec3): number[]
export function boardMesh(
	circuit: any[],
	parts?: { ref: string; role?: string }[],
): { positions: Float32Array; colors: number[][]; refs: (string | null)[]; kinds: ("slab" | "pad" | "part")[]; bounds: { min: number[]; max: number[] } }
export function placeBoardInCase(caseTris: Float32Array, board: { min: number[]; max: number[] }): [number, number, number]

export interface Camera { eye: number[]; forward: number[]; right: number[]; up: number[]; fov: number }
export function orbitCamera(o: { yaw: number; pitch: number; distance: number; target: Vec3; fov?: number }): Camera
export function project(cam: Camera, p: Vec3, width: number, height: number): [number, number, number]
export function triNormal(tris: Float32Array, i: number): number[]
export function shade(rgb: number[], normal: number[], light: number[]): number[]

export interface SceneView {
	update(input: { caseStl?: ArrayBuffer | null; circuit?: any[] | null }): void
	setExplode(t: number): void
	highlight(ref: string | null): void
	setParts(parts: { ref: string; role?: string }[]): void
}
export function mountScene(el: HTMLElement, opts?: { onHover?(ref: string | null): void; parts?: { ref: string; role?: string }[] }): SceneView
