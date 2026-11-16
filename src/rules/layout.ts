import type { CheckCatalog } from "../mechanics/checks.ts"
import { byMpn } from "../mechanics/catalog.ts"
import { mounts } from "../mechanics/model.ts"
import { ESTOP_CLEARANCE_MM, ESTOP_DECK_MARGIN_MM } from "../mechanics/safety.ts"
import type { Mechanics } from "../mechanics/types.ts"
import type { ContractValues } from "../contract/types.ts"

// What a competition's rules add to a robot's layout, so the chassis solver (layout_chassis) returns a layout that
// passes them as it is. Real run 11 (Eurobot brief, 16 Nov 2026): the solver laid out a plain rover, the mechanics agent
// then added the rules' parts by hand at rev 37-40: a made-up e-stop ("ESTOP-RED-20MM"), the beacon support 164.7 mm from
// the centre, a 1625 g robot that tipped and lacked torque. Applied to every candidate layout before it is checked.
// Fixed names: the e-stop's plug JE1, the start's JS1 (mechanics/refs.ts).
const MAST_SOCKET_MM = 2.2 // the beacon socket's wall and fit around the mast (py/chassis.py)
export const BEACON_BRAKE_CAP_MPS2 = 1.5 // a robot carrying the beacon high brakes and starts no harder (firmware ramp)

export function completeForRules(mech: Mechanics, v: Partial<ContractValues>, cat: CheckCatalog): Mechanics {
	const id = v.motion?.rules
	const rules = id ? cat.rules?.[id] : undefined
	if (!rules) return mech
	const L = rules.limits
	const m: Mechanics = JSON.parse(JSON.stringify(mech))
	const [PL, PW] = m.chassis.plateMm
	const plateTop = m.chassis.clearanceMm + m.chassis.thicknessMm
	// The beacon support at the robot's centre (F.6), its smallest allowed size, carrying its load.
	m.beacon = { at: { xMm: 0, yMm: 0 }, topMm: L.beaconTopMm.value, sizeMm: L.beaconMinMm.value, mastWallMm: m.beacon?.mastWallMm ?? 1.2, loadG: Math.max(m.beacon?.loadG ?? 0, L.beaconLoadG.value) }
	const keep = m.beacon.sizeMm / 2 + MAST_SOCKET_MM + 2 // clear of the mast's socket, with 2 mm of air
	// The pack beside the mast when it would stand in it.
	const pack = byMpn(cat.mech.batteries, m.battery.pack)
	if (pack && Math.abs(m.battery.at.xMm) < keep + pack.sizeMm[0] / 2 && Math.abs(m.battery.at.yMm) < keep + pack.sizeMm[1] / 2)
		m.battery.at = { xMm: m.battery.at.xMm, yMm: Math.min(PW / 2 - pack.sizeMm[1] / 2 - 2, keep + pack.sizeMm[1] / 2) }
	// Boards behind the mast when they would stand in it (not a system's: its assembly places them).
	if (!v.assembly)
		m.chassis.boards = m.chassis.boards.map((b) => {
			const o = v.outline, w = o?.widthMm ?? 40, h = o?.heightMm ?? 30
			const [bw, bh] = b.rotDeg === 90 || b.rotDeg === 270 ? [h, w] : [w, h]
			return Math.abs(b.at.xMm) < keep + bw / 2 && Math.abs(b.at.yMm) < keep + bh / 2 ? { ...b, at: { xMm: -(keep + bw / 2 + 2), yMm: b.at.yMm } } : b
		})
	// A pull-cord start (F.6) and the match's end (H.3).
	m.safety = { ...m.safety, start: { connector: "JS1", cordMm: Math.max(m.safety?.start?.cordMm ?? 0, L.cordMinMm.value), matchS: L.matchS.value } }
	// The emergency stop (F.4.c): the catalog's button, ahead of the mast, its deck high enough that its body clears what
	// stands under it, the collar keeping its head within the rules' allowance over the robot.
	const button = (cat.mech.safety ?? []).find((p) => p.kind === "estop" && byMpn(cat.mech.safety ?? [], m.safety?.estop?.part ?? "")?.mpn === p.mpn) ?? (cat.mech.safety ?? []).find((p) => p.kind === "estop")
	if (button) {
		const r = button.headMm / 2 + ESTOP_DECK_MARGIN_MM
		const x = Math.min(PL / 2 - r, keep + r)
		const below = mounts({ ...m, safety: { ...m.safety, estop: undefined } }, [{ name: "main", outline: { widthMm: v.outline?.widthMm ?? 40, heightMm: v.outline?.heightMm ?? 30 } }], cat.mech)
			.filter((q) => !/^(plate|wheel:|motor:|caster|beacon|payload)/.test(q.what) && Math.abs(q.xMm - x) < button.bodyMm / 2 + q.sizeMm[0] / 2 && Math.abs(q.yMm) < button.bodyMm / 2 + q.sizeMm[1] / 2)
		const floorTop = Math.max(plateTop, ...below.map((q) => q.zMm + q.sizeMm[2] / 2))
		const zMm = Math.ceil(floorTop + ESTOP_CLEARANCE_MM + button.belowMm + 1)
		const collarMm = Math.max(0, Math.ceil(button.aboveMm - L.estopAboveRobotMm.value))
		m.safety = { ...m.safety, estop: { part: button.mpn, at: { xMm: Math.round(x), yMm: 0, zMm }, connector: "JE1", collarMm } }
	}
	// The beacon high up: brakes and starts no harder than the cap (firmware ramp, mechanics.drive.maxAccelMps2).
	m.drive = { ...m.drive, maxAccelMps2: Math.min(m.drive.maxAccelMps2 ?? Infinity, BEACON_BRAKE_CAP_MPS2) }
	return m
}
