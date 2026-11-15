// The compute checks (src/system/compute.ts) over a whole system, as system findings (src/system/checks.ts): each
// bought board against the robot's battery and motors (the board whose contract holds the mechanics), its HAT carrier's
// regulator and header, and its place on the plate. A missing value is a warning (it never blocks a settle); a failed
// check is an error, sent to the board that can fix it.
import { resolve } from "node:path"
import type { ContractSnapshot } from "../contract/types.ts"
import { byMpn, loadMechCatalog, type MechCatalog } from "../mechanics/catalog.ts"
import { est } from "../mechanics/estimates.ts"
import type { SystemAssembly } from "./assembly.ts"
import { moduleById } from "./bought.ts"
import type { SystemFinding } from "./checks.ts"
import { headerCheck, headerSignals, mechanicsCheck, powerBudget, railCheck, regulatorFromCatalog, type ComputeFinding, type SensorMount } from "./compute.ts"
import type { SystemSpec } from "./spec.ts"

const ROOT = resolve(import.meta.dirname, "../..")
let catalog: MechCatalog | null = null
const mechCatalog = () => (catalog ??= loadMechCatalog(ROOT))

// The carrier's regulator, when the spec (the carrier board's `regulator`) or the robot's mechanics (`regulator`, an mpn
// or {mpn}) names one from catalog/mechanics.json's regulators; null otherwise (the checks then say it isn't chosen).
function namedRegulator(carrier: { regulator?: string } | undefined, mech: unknown, cat: MechCatalog) {
	const m = (mech as { regulator?: string | { mpn?: string } } | undefined)?.regulator
	const mpn = carrier?.regulator ?? (typeof m === "string" ? m : m?.mpn)
	const rec = mpn ? byMpn(cat.regulators ?? [], mpn) : undefined
	return rec ? regulatorFromCatalog(rec as unknown as Record<string, unknown>) : null
}

export function boughtChecks(spec: SystemSpec, contracts: Record<string, ContractSnapshot | undefined>, assembly?: SystemAssembly): SystemFinding[] {
	const bought = spec.boards.filter((b) => b.kind === "bought" && b.module)
	if (!bought.length) return []
	const cat = mechCatalog()
	const ownerName = spec.boards.find((b) => contracts[b.name]?.values.mechanics)?.name
	const owner = ownerName ? contracts[ownerName] : undefined
	const mech = owner?.values.mechanics
	const battery = mech ? byMpn(cat.batteries, mech.battery.pack) ?? null : null
	const motorPart = mech ? byMpn(cat.motors, mech.drive.motor) : undefined
	const motors = !mech ? ("none" as const) : motorPart ? { part: motorPart, count: 2 } : null
	// The designed boards' known draw (their rails' peaks); unknown when any has none yet.
	const designed = spec.boards.filter((b) => b.kind !== "bought")
	const rails = designed.map((b) => contracts[b.name]?.values.rails)
	const otherBoardsA = rails.every((r) => r && r.length) ? rails.reduce((t, r) => t + r!.reduce((s, x) => s + x.loadMa, 0), 0) / 1000 : null
	const out: SystemFinding[] = []
	for (const b of bought) {
		const m = moduleById(b.module!)
		if (!m) continue
		const carrier = spec.boards.find((x) => x.carries === b.name)
		const regulator = namedRegulator(carrier, mech, cat)
		const add = (fs: ComputeFinding[], fixers: string[]) => {
			for (const f of fs) out.push({ kind: f.check, link: "", message: `${b.name}: ${f.message}`, boards: f.level === "error" ? fixers : [], ...(f.level === "warning" ? { level: "warning" as const } : {}) })
		}
		add(powerBudget(m, { battery, motors, regulator, otherBoardsA }), ownerName ? [ownerName] : [])
		if (carrier) {
			add(railCheck(m, regulator), [carrier.name])
			add(headerCheck(m, headerSignals(m, carrier.bridge ?? "usb")), [carrier.name])
		} else out.push({ kind: "compute-rail", link: "", message: `${b.name}: no carrier in the system feeds it through its header (add one: src/system/carrier.ts addCarrier); its rail and header can't be checked`, boards: [], level: "warning" })
		const placed = assembly?.boards.find((x) => x.name === b.name)
		if (assembly?.body === "chassis" && assembly.plate && placed) {
			// The sensor's mount as the mechanics model has it (src/mechanics/model.ts), the board on the plate's standoffs.
			const s = mech?.sensor ? byMpn(cat.sensors ?? [], mech.sensor.module) : undefined
			const sensor: SensorMount | null = s && mech ? { xMm: mech.sensor.at.xMm, yMm: mech.sensor.at.yMm, zMm: mech.sensor.at.zMm, sizeMm: [s.sizeMm[2], s.sizeMm[0], s.sizeMm[1]] } : null
			const baseZMm = mech ? mech.chassis.clearanceMm + mech.chassis.thicknessMm + (placed.standoffMm ?? est("standoffMm")) : undefined
			add(mechanicsCheck(m, { placed, plate: assembly.plate, others: assembly.boards, sensor, ...(baseZMm !== undefined ? { baseZMm } : {}), maxHeightMm: null, hat: carrier?.name ?? null }), [])
		}
	}
	return out
}
