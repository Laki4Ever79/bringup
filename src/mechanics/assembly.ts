// A board's view of its system's assembly (src/system/assembly.ts): the plate and where every board sits, owned by the
// system's integrator. A robot board's mechanics, chassis builder and checks read the layout through here, so the
// mechanics agent no longer invents it (it keeps the drive, battery, sensor, clearance and thickness).
import type { ContractSnapshot, ContractValues } from "../contract/types.ts"
import type { SystemAssembly } from "../system/assembly.ts"
import type { Mechanics } from "./types.ts"

// What one board is handed: the whole body, and which board it is. Inside the board's own contract it is called "main".
export type BoardAssembly = SystemAssembly & { self: string }

const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const pos = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0
const fin = (v: unknown) => typeof v === "number" && Number.isFinite(v)

export function boardAssemblyShapeError(v: unknown): string | null {
	const shape = 'assembly must be {body: "chassis"|"enclosure"|"separate", plate?: {lengthMm, widthMm}, self (a name in boards), boards: [{name, xMm, yMm (the board\'s centre), rotDeg: 0|90|180|270, outline: {widthMm, heightMm}, outlineSource: "estimate"|"built"}]}'
	if (!obj(v) || !["chassis", "enclosure", "separate"].includes(v.body as string) || typeof v.self !== "string" || !Array.isArray(v.boards)) return shape
	if (v.plate !== undefined && !(obj(v.plate) && pos(v.plate.lengthMm) && pos(v.plate.widthMm))) return shape
	for (const b of v.boards) {
		if (!obj(b) || typeof b.name !== "string" || !fin(b.xMm) || !fin(b.yMm) || !obj(b.outline) || !pos(b.outline.widthMm) || !pos(b.outline.heightMm) || !["estimate", "built"].includes(b.outlineSource as string)) return shape
		if (![0, 90, 180, 270].includes(b.rotDeg as number)) return `assembly: board ${b.name} is rotated ${String(b.rotDeg)}°; use 0, 90, 180 or 270`
	}
	if (!(v.boards as { name: string }[]).some((b) => b.name === v.self)) return `assembly: self "${v.self}" is not one of its boards`
	return null
}

const asMain = (a: BoardAssembly, name: string) => (name === a.self ? "main" : name)

// The mechanics with the assembly's plate and board places over the agent's; unchanged when there is no assembly.
export function withAssembly(values: ContractValues | Partial<ContractValues>): Mechanics | undefined {
	const mech = values.mechanics, a = values.assembly
	if (!mech || !a) return mech
	return {
		...mech,
		chassis: {
			...mech.chassis,
			plateMm: a.plate ? [a.plate.lengthMm, a.plate.widthMm] : mech.chassis.plateMm,
			boards: a.boards.map((b) => ({ name: asMain(a, b.name), at: { xMm: b.xMm, yMm: b.yMm }, rotDeg: b.rotDeg, ...(b.carries ? { on: asMain(a, b.carries) } : {}), ...(b.holes ? { holes: b.holes } : {}) })),
		},
	}
}

// Every board's outline the assembly knows, by the names this board's contract uses ("main" = self).
export function assemblyOutlines(values: ContractValues | Partial<ContractValues>): { name: string; outline: { widthMm: number; heightMm: number } }[] {
	const a = values.assembly
	if (!a) return []
	return a.boards.map((b) => ({ name: asMain(a, b.name), outline: { ...b.outline } }))
}

// This board's own outline ("main", the truth even when the assembly's copy lags) and the other boards' from the assembly,
// as the checks and the mass need them.
export function outlinesWithAssembly(values: Partial<ContractValues>): { name: string; outline: { widthMm: number; heightMm: number } }[] {
	const own = { name: "main", outline: { widthMm: values.outline?.widthMm ?? 0, heightMm: values.outline?.heightMm ?? 0 } }
	const fromAssembly = assemblyOutlines(values)
	return [own, ...fromAssembly.filter((a) => a.name !== "main")]
}

// The boards the mechanics checks run over for one board's snapshot: itself, and the assembly's other boards as stubs
// that carry only an outline (their parts and pins belong to their own contracts).
export function checkBoards(c: ContractSnapshot): { name: string; snapshot: ContractSnapshot }[] {
	return outlinesWithAssembly(c.values).map((o) => o.name === "main" ? { name: "main", snapshot: c } : { name: o.name, snapshot: { ...c, values: { outline: { ...o.outline, thicknessMm: 1.6, sizeReason: c.values.outline?.sizeReason as never } } } })
}
