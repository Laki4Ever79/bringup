import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { kicadCli, type Env } from "./env.ts"

// JLCPCB's standard 2-layer capabilities, so the check says whether a fab can actually make the board
// (KiCad's own defaults are stricter than any fab and would flag every tscircuit board).
export const FAB_RULES = { name: "JLCPCB 2-layer", minTrackMm: 0.1, minClearanceMm: 0.1, minViaDiameterMm: 0.4, minViaDrillMm: 0.2, minAnnularMm: 0.1, minHoleClearanceMm: 0.2, minHoleToHoleMm: 0.25, minEdgeClearanceMm: 0.3 }

export interface DrcSummary {
	rules: string
	errors: number
	warnings: number
	unconnected: number
	byType: Record<string, number>
	firstError: string | null
	// Errors whose items all belong to one part, by ref: the part's own land pattern against the fab's generic rule
	// (e.g. a USB-C receptacle's GND pads 0.17 mm from its own locating holes), not the layout. Still errors.
	ownFootprint?: Record<string, number>
}

// "Pad 5 [GND] of J1 on F.Cu", "NPTH pad of J1" → J1; a track or zone has no part.
const partOf = (item: { description?: string }) => /\bof ([A-Z]+\d+)\b/.exec(item.description ?? "")?.[1] ?? null

// Adds the fab's board rules and default net class to a KiCad project, keeping everything else.
export function applyFabRules(project: Record<string, any>): Record<string, any> {
	const p = structuredClone(project)
	p.board ??= {}
	p.board.design_settings ??= {}
	p.board.design_settings.rules = {
		...(p.board.design_settings.rules ?? {}),
		min_clearance: FAB_RULES.minClearanceMm,
		min_track_width: FAB_RULES.minTrackMm,
		min_via_diameter: FAB_RULES.minViaDiameterMm,
		min_via_annular_width: FAB_RULES.minAnnularMm,
		min_through_hole_diameter: FAB_RULES.minViaDrillMm,
		min_hole_clearance: FAB_RULES.minHoleClearanceMm,
		min_hole_to_hole: FAB_RULES.minHoleToHoleMm,
		min_copper_edge_clearance: FAB_RULES.minEdgeClearanceMm,
	}
	p.net_settings ??= {}
	const classes: any[] = (p.net_settings.classes ??= [])
	const def = classes.find((c) => c.name === "Default") ?? (classes.push({ name: "Default" }), classes.at(-1))
	Object.assign(def, { clearance: FAB_RULES.minClearanceMm, track_width: 0.15, via_diameter: 0.45, via_drill: 0.25 })
	return p
}

export function summarizeDrc(report: { violations?: { type: string; severity: string; description: string; items?: { description?: string }[] }[]; unconnected_items?: unknown[] }): DrcSummary {
	const v = report.violations ?? []
	const byType: Record<string, number> = {}
	for (const x of v) byType[x.type] = (byType[x.type] ?? 0) + 1
	const ownFootprint: Record<string, number> = {}
	for (const x of v) {
		if (x.severity !== "error" || !x.items?.length) continue
		const refs = new Set(x.items.map(partOf))
		const [ref] = refs
		if (refs.size === 1 && ref) ownFootprint[ref] = (ownFootprint[ref] ?? 0) + 1
	}
	return {
		rules: FAB_RULES.name,
		errors: v.filter((x) => x.severity === "error").length,
		warnings: v.filter((x) => x.severity === "warning").length,
		unconnected: (report.unconnected_items ?? []).length,
		byType,
		firstError: v.find((x) => x.severity === "error")?.description ?? null,
		ownFootprint,
	}
}

// Runs KiCad's design-rule check against the fab rules. Best-effort: returns null if KiCad can't run.
export async function runDrc(env: Env, workDir: string, pcbRel: string, proRel: string): Promise<DrcSummary | null> {
	try {
		const proPath = join(workDir, proRel)
		writeFileSync(proPath, JSON.stringify(applyFabRules(JSON.parse(readFileSync(proPath, "utf8"))), null, 2))
	} catch {
		// No project file: KiCad falls back to its defaults; the summary still reports what it finds.
	}
	const r = await kicadCli(env, ["pcb", "drc", "--format", "json", "--severity-all", "-o", "drc.json", pcbRel], workDir, 180_000)
	try {
		return summarizeDrc(JSON.parse(readFileSync(join(workDir, "drc.json"), "utf8")))
	} catch {
		return r.code === 0 ? null : null
	}
}
