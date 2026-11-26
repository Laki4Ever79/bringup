// A bought board in a system (docs/superpowers/specs/2026-11-15-compute-modules-design.md): a compute module from the
// module library (catalog/modules/<id>.json, kind "compute") that nobody designs. Its outline, holes, header and power
// come from the record; agents never run for it. The board it plugs into, its carrier, is designed (carrier.ts).
import { resolve } from "node:path"
import type { ContractSnapshot } from "../contract/types.ts"
import { loadModules, type Module } from "../modules/library.ts"

const ROOT = resolve(import.meta.dirname, "../..")

// The carrier is a HAT on top of the module: the gap between them, with its source (assembly-geom.js).
import { HAT_STACK_MM, HAT_STACK_SOURCE } from "../geometry/assembly-geom.js"
export const HAT_STACK = { mm: HAT_STACK_MM, source: HAT_STACK_SOURCE }

// The library is read once per root: specErrors runs on every drag of a plan.
const cache = new Map<string, Module[]>()
export function libraryModules(root = ROOT): Module[] {
	let m = cache.get(root)
	if (!m) cache.set(root, (m = loadModules(root)))
	return m
}

export const moduleById = (id: string, root = ROOT): Module | undefined => libraryModules(root).find((m) => m.id === id)

export interface Cite { url: string; where: string }
export interface Sourced<T> { value: T | null; source?: Cite | null; note?: string; unit?: string }
type Outline = { widthMm: number; heightMm: number }
export interface Hole { x: number; y: number; dia: number | null } // dia null: the record doesn't give it

// One sourced value of the compute block by its path ("currentA.peak"), or undefined when the record has no such entry.
export function field<T>(m: Module, path: string): Sourced<T> | undefined {
	let x: unknown = m.compute
	for (const k of path.split(".")) x = x && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined
	return x && typeof x === "object" && "value" in x ? (x as Sourced<T>) : undefined
}

export const moduleOutline = (m: Module): Outline | null => {
	const o = field<Outline>(m, "outline")?.value
	return o && o.widthMm > 0 && o.heightMm > 0 ? { widthMm: o.widthMm, heightMm: o.heightMm } : null
}
export const moduleHoles = (m: Module): Hole[] => field<Hole[]>(m, "holes")?.value ?? []

// Why a spec board can't be a bought board, in words; [] when it can.
export function boughtErrors(b: { name: string; kind?: string; module?: string; brief?: string; run?: string }, root = ROOT): string[] {
	if (b.kind !== "bought") return []
	if (b.brief || b.run) return [`board ${b.name}: a bought board is not designed: give a module, not a brief or a run`]
	if (!b.module) return [`board ${b.name}: a bought board needs a module (an id in catalog/modules, e.g. rpi-5)`]
	const m = moduleById(b.module, root)
	const compute = libraryModules(root).filter((x) => x.kind === "compute").map((x) => x.id)
	if (!m) return [`board ${b.name}: no module ${b.module} in catalog/modules (compute modules: ${compute.join(", ") || "none"})`]
	if (m.kind !== "compute") return [`board ${b.name}: module ${b.module} is a ${m.kind} module, not a compute board; a bought board is one of: ${compute.join(", ") || "none"}`]
	if (!moduleOutline(m)) return [`board ${b.name}: module ${b.module} has no outline, so it can't be placed`]
	return []
}

// What the system reads of a bought board where a designed one has its contract: its outline, and nothing else to
// design. The thickness is a standard 1.6 mm PCB (estimate: the record doesn't give it).
export function boughtContract(m: Module): ContractSnapshot {
	const o = moduleOutline(m)
	return { revision: 0, values: o ? { outline: { ...o, thicknessMm: 1.6 } } : {}, versions: {} as ContractSnapshot["versions"] }
}

// The outlines of a spec's bought boards, by board name (they are known before anything runs).
export function boughtOutlines(boards: { name: string; kind?: string; module?: string }[], root = ROOT): Record<string, Outline> {
	const out: Record<string, Outline> = {}
	for (const b of boards) {
		const m = b.kind === "bought" && b.module ? moduleById(b.module, root) : undefined
		const o = m && moduleOutline(m)
		if (o) out[b.name] = o
	}
	return out
}
