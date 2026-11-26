// The arm's servo plugs against their rated current (arm task 6, lead decision 25 Nov 2026). Each plug carries one servo
// at stall at the arm's rail voltage (servoAt), asked CONNECTOR_HEADROOM over it. Over the plug's plain rating is a
// violation; between the plain rating and the headroom it is a figure, not a violation: the PZ254V's 3 A against an
// MG996R's 2.5 A at 6 V (3.1 A with the headroom). No 2.54 mm header is sourced above 3 A and assembled by JLCPCB, and the
// servo's own 2.54 mm lead housing (about 3 A, an estimate) is the real limit, so the figure's note names it.
import { servoAt, type ServoPart } from "../mechanics/catalog.ts"
import { CONNECTOR_HEADROOM, type MechFigure, type Source } from "../mechanics/checks.ts"

export const SERVO_LEAD_NOTE = "the servo's own 2.54 mm lead housing (about 3 A, an estimate) is the real limit, not this header"

export interface ArmPlug {
	ref: string
	plug: { mpn: string; ratedA?: number; source?: Record<string, { url: string; where: string }> }
	servo: ServoPart
	railV: number
}

export function armPlugFigures(plugs: ArmPlug[]): { figures: MechFigure[]; violations: { kind: "arm-current"; message: string }[] } {
	const figures: MechFigure[] = []
	const violations: { kind: "arm-current"; message: string }[] = []
	const r2 = (x: number) => +x.toFixed(2)
	for (const p of plugs) {
		const at = servoAt(p.servo, p.railV)
		const rated = p.plug.ratedA
		if ("error" in at || rated === undefined) continue
		const sources: Source[] = [
			...(p.plug.source?.ratedA ? [{ mpn: p.plug.mpn, field: "ratedA", ...p.plug.source.ratedA }] : []),
			...(p.servo.source?.stallA ? [{ mpn: p.servo.mpn, field: "stallA", ...p.servo.source.stallA }] : []),
		]
		figures.push({
			check: `Connector current ${p.ref}`,
			value: `${r2(at.stallA)} A`,
			limit: `at most ${r2(rated / CONNECTOR_HEADROOM)} A (${rated} A rated, ${CONNECTOR_HEADROOM}x headroom)`,
			ok: at.stallA * CONNECTOR_HEADROOM <= rated,
			note: `${p.plug.mpn}: one ${p.servo.mpn} at stall at ${p.railV} V; ${SERVO_LEAD_NOTE}`,
			...(sources.length ? { sources } : {}),
		})
		if (at.stallA > rated) violations.push({ kind: "arm-current", message: `${p.ref} ${p.plug.mpn} is rated ${rated} A but one ${p.servo.mpn} at stall draws ${r2(at.stallA)} A at ${p.railV} V: use a plug rated for it` })
	}
	return { figures, violations }
}
