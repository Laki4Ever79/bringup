import type { SystemAssembly } from "../system/assembly.ts"
import type { SystemLink } from "../system/spec.ts"
import type { ChassisSpec } from "../tools/chassis.ts"

export type EditOp =
	| { kind: "move"; board: string; xMm: number; yMm: number }
	| { kind: "rotate"; board: string }
	| { kind: "plate"; lengthMm: number; widthMm: number }
	| { kind: "standoff"; board: string; heightMm: number }
	| { kind: "cable-add"; a: string; b: string; cableKind?: string }
	| { kind: "cable-remove"; link: string }
	| { kind: "cable-kind"; link: string; cableKind: string }
	| { kind: "cable-route"; link: string; points: { xMm: number; yMm: number }[] }
	| { kind: "cable-edge"; link: string; end: "a" | "b"; edge: "left" | "right" | "top" | "bottom" }
export interface EditStart { assembly: SystemAssembly; links: SystemLink[]; chassis?: ChassisSpec | null; maxSizeMm?: [number, number] | null; i2cDevicesByBoard?: Record<string, number> }
export interface EditFinding { target: { board?: string; link?: string; plate?: true }; level: "error" | "warn"; message: string }
export interface Editor {
	apply(op: EditOp): boolean
	undo(): boolean
	redo(): boolean
	canUndo(): boolean
	canRedo(): boolean
	state(): { assembly: SystemAssembly; links: SystemLink[] }
	diff(): { assembly?: Partial<SystemAssembly>; links?: SystemLink[] } | null
	markApplied(): void
	findings(): EditFinding[]
}
export const SNAP_MM: number
export const STANDOFF_DEFAULT_MM: number
export const STANDOFF_RANGE_MM: [number, number]
export const STANDOFF_USUAL_MM: [number, number]
export function keepOuts(chassis: ChassisSpec | null | undefined): { what: string; xMm: number; yMm: number; wMm: number; hMm: number; thickMm?: number }[]
export function editor(start: EditStart): Editor
