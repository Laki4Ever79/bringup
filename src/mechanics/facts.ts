import type { ContractSnapshot } from "../contract/types.ts"
import { defaultCheckCatalog } from "./checks.ts"
import { massAndCom, mounts } from "./model.ts"

// What a robot's designers see each turn (design-facts.ts): the drive catalog with its cited numbers, and the mass and
// centre of mass computed from the current design. Nothing for a board without motion targets.
export function mechanicsFactLines(s: ContractSnapshot): string[] {
	const v = s.values
	if (!v.motion) return []
	const cat = defaultCheckCatalog()
	if (!cat) return []
	const m = cat.mech
	const lines = ["", "## Mechanics (catalog/mechanics.json, every number from a datasheet; computed values below)"]
	lines.push("- Motors:", ...m.motors.map((x) => `  - ${x.mpn}: ${x.ratedV} V, ${x.noLoadRpm} rpm, stall ${x.stallTorqueNm} N·m / ${x.stallA} A, no-load ${x.noLoadA} A, ${x.bodyMm.join(" × ")} mm, ${x.massG} g`))
	lines.push("- Wheels:", ...m.wheels.map((x) => `  - ${x.mpn}: ø${x.diameterMm} × ${x.widthMm} mm, ${x.shaftMm} mm shaft, ${x.massG} g`))
	lines.push("- Casters:", ...m.casters.map((x) => `  - ${x.mpn}: ø${x.wheelMm} mm wheel, ${x.heightMm} mm high, ${x.massG} g`))
	lines.push("- Packs:", ...m.batteries.map((x) => `  - ${x.mpn}: ${x.cells} cell ${x.nominalV} V (${x.cutoffV}–${x.fullV} V), ${x.mAh} mAh, ${x.maxContA} A continuous, ${x.peakA} A peak, ${x.sizeMm.join(" × ")} mm, ${x.massG} g`))
	lines.push("- Distance sensors:", ...(m.sensors ?? []).map((x) => `  - ${x.mpn}: ${x.chip}, ${x.rangeMm} mm range, ${x.updateMs} ms per reading, ${x.sizeMm.join(" × ")} mm, ${x.massG} g, ${x.connector}`))
	if (v.mechanics) {
		const { massG, com } = massAndCom(mounts(v.mechanics, [{ name: "main", outline: { widthMm: v.outline?.widthMm ?? 0, heightMm: v.outline?.heightMm ?? 0 } }], m))
		lines.push(`- Computed: mass about ${Math.round(massG + v.motion.payloadG)} g with the ${v.motion.payloadG} g payload; centre of mass (${com.map((c) => c.toFixed(1)).join(", ")}) mm without it`)
	}
	return lines
}
