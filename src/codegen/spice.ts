import type { ContractSnapshot, Rail } from "../contract/types.ts"

export interface PowerScenario {
	name: string
	vinV: number
}

// AP2112K-class LDO, worst case from the datasheet: 400 mV dropout at rated current (typ is 250 mV), 55 µA quiescent.
// Dropout is modelled as a resistance that reaches DROPOUT_MV at the rail's regulatorMaxMa.
export const DROPOUT_MV = 400
export const QUIESCENT_A = 55e-6

export function railId(rail: Rail): string {
	return rail.name.toLowerCase().replace(/[^a-z0-9]/g, "_")
}

export function dropoutOhms(rail: Rail): number {
	return DROPOUT_MV / rail.regulatorMaxMa
}

// The rails an LDO makes from the input. VBUS/USB is the input and VBAT/BAT the cell itself (the same names power.ts
// treats as the source), so they are not modelled as regulators.
export function regulatedRails(rails: Rail[]): Rail[] {
	return rails.filter((r) => !/VBUS|USB|BAT/i.test(r.name))
}

// ngspice deck for one supply scenario: every rail's LDO fed from the same input, each into a resistive load
// that draws loadMa at the set voltage. A single-point .dc sweep lets .meas report the operating point.
export function powerDeck(s: ContractSnapshot, scenario: PowerScenario): string {
	if (!s.values.rails?.length) throw new Error("power simulation needs rails in the contract")
	const rails = regulatedRails(s.values.rails)
	if (!rails.length) throw new Error("power simulation found no regulated rail (rails named VBUS/USB/BAT are the input and the cell)")
	const lines = [
		`* Bringup power path, scenario ${scenario.name}, contract revision ${s.revision}. Generated; do not edit.`,
		`.param vin=${scenario.vinV}`,
		"Vin in 0 DC {vin}",
	]
	for (const rail of rails) {
		const id = railId(rail)
		lines.push(
			"",
			`* rail ${rail.name}: ${rail.voltageV} V, ${rail.loadMa} mA load, regulator rated ${rail.regulatorMaxMa} mA`,
			`.param vset_${id}=${rail.voltageV}`,
			`.param iload_${id}=${rail.loadMa / 1000}`,
			`.param rdo_${id}=${dropoutOhms(rail)}`,
			// Output follows the set point until the input minus the dropout drop can no longer reach it.
			`Bpass_${id} out_${id} 0 V = min({vset_${id}}, V(in) - {rdo_${id}}*I(Vsense_${id}))`,
			`Vsense_${id} out_${id} load_${id} DC 0`,
			// A rail with no stated load gets an open load; vset/0 would be an infinite resistance ngspice rejects.
			rail.loadMa > 0 ? `Rload_${id} load_${id} 0 {vset_${id}/iload_${id}}` : `Rload_${id} load_${id} 0 1e9`,
			// The input supplies the load current plus quiescent current.
			`Bin_${id} in 0 I = I(Vsense_${id}) + ${QUIESCENT_A}`,
		)
	}
	lines.push("", ".dc Vin {vin} {vin} 1")
	for (const rail of rails) {
		const id = railId(rail)
		lines.push(`.meas dc vout_${id} MAX v(out_${id})`, `.meas dc iout_${id} MAX i(Vsense_${id})`)
	}
	lines.push(".end", "")
	return lines.join("\n")
}
