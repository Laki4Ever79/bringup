import { byMpn, type MechCatalog, type MotorPart } from "./catalog.ts"
import { est } from "./estimates.ts"
import type { Mechanics, Mount } from "./types.ts"

export const G = 9.81

// A brushed DC gearmotor as a linear motor at the output shaft, from its datasheet's rated voltage, no-load speed,
// stall torque and stall current. At voltage V: no-load speed and stall torque scale with V/ratedV, the winding
// resistance R = ratedV / stallA stays, so stall current = V / R. kt = stall torque / stall current (output N·m per A),
// ke = V / no-load speed (V per rad/s), both at the output shaft.
export function motorAt(m: MotorPart, volts: number): { noLoadRadS: number; stallNm: number; stallA: number; kt: number; ke: number; rOhm: number } {
	const k = volts / m.ratedV
	const noLoadRadS = (m.noLoadRpm * 2 * Math.PI) / 60 * k
	const rOhm = m.ratedV / m.stallA
	const stallA = volts / rOhm
	const stallNm = m.stallTorqueNm * k
	return { noLoadRadS, stallNm, stallA, kt: stallA > 0 ? stallNm / stallA : 0, ke: noLoadRadS > 0 ? volts / noLoadRadS : 0, rOhm }
}

// The horizontal force at the axle that lifts a wheel of radius r over a step of height h carrying weight m·g:
// F = W·√(h(2r−h)) / (r−h) (moments about the step's edge). A step at or above the axle can't be climbed: Infinity.
export function edgeForceN(massKg: number, wheelRadiusM: number, edgeM: number): number {
	const r = wheelRadiusM, h = edgeM
	if (h <= 0) return 0
	if (h >= r) return Infinity
	return (massKg * G * Math.sqrt(h * (2 * r - h))) / (r - h)
}

// Every part's place, size and mass in the chassis frame (types.ts). Motors and wheels on the axle at x = axleXMm, the
// caster wheelbaseMm behind it, the battery on the plate, boards on standoffs above it. Board mass from the outline
// (estimate) unless given; the plate's from its volume and PLA density (estimate).
export function mounts(mech: Mechanics, boards: { name: string; outline: { widthMm: number; heightMm: number }; massG?: number }[], cat: MechCatalog): Mount[] {
	const d = mech.drive, c = mech.chassis
	const motor = byMpn(cat.motors, d.motor), wheel = byMpn(cat.wheels, d.wheel), caster = byMpn(cat.casters, d.caster), pack = byMpn(cat.batteries, mech.battery.pack)
	const out: Mount[] = []
	const r = (wheel?.diameterMm ?? 60) / 2
	const plateZ = c.clearanceMm + c.thicknessMm / 2
	const plateTop = c.clearanceMm + c.thicknessMm
	out.push({ what: "plate", xMm: 0, yMm: 0, zMm: plateZ, sizeMm: [c.plateMm[0], c.plateMm[1], c.thicknessMm], massG: (c.plateMm[0] * c.plateMm[1] * c.thicknessMm * est("plaDensityGcm3")) / 1000 })
	for (const [side, s] of [["left", 1], ["right", -1]] as const) {
		if (motor) out.push({ what: `motor:${side}`, xMm: d.axleXMm, yMm: s * (d.trackMm / 2 - (wheel?.widthMm ?? 8) / 2 - motor.bodyMm[0] / 2), zMm: r, sizeMm: [motor.bodyMm[1], motor.bodyMm[0], motor.bodyMm[2]], massG: motor.massG })
		if (wheel) out.push({ what: `wheel:${side}`, xMm: d.axleXMm, yMm: (s * d.trackMm) / 2, zMm: r, sizeMm: [wheel.diameterMm, wheel.widthMm, wheel.diameterMm], massG: wheel.massG })
	}
	if (caster) out.push({ what: "caster", xMm: d.axleXMm - d.wheelbaseMm, yMm: 0, zMm: caster.heightMm / 2, sizeMm: [caster.wheelMm, caster.wheelMm, caster.heightMm], massG: caster.massG })
	if (pack) out.push({ what: "battery", xMm: mech.battery.at.xMm, yMm: mech.battery.at.yMm, zMm: plateTop + pack.sizeMm[2] / 2, sizeMm: pack.sizeMm, massG: pack.massG })
	for (const b of c.boards) {
		const info = boards.find((x) => x.name === b.name)
		if (!info) continue
		const turned = b.rotDeg === 90 || b.rotDeg === 270
		const w = turned ? info.outline.heightMm : info.outline.widthMm, h = turned ? info.outline.widthMm : info.outline.heightMm
		out.push({ what: `board:${b.name}`, xMm: b.at.xMm, yMm: b.at.yMm, zMm: plateTop + est("standoffMm") + 0.8, sizeMm: [w, h, 1.6], massG: info.massG ?? ((w * h) / 100) * est("boardMassGPerCm2") })
	}
	return out
}

export function massAndCom(ms: Mount[]): { massG: number; com: [number, number, number] } {
	const massG = ms.reduce((t, m) => t + m.massG, 0)
	if (!massG) return { massG: 0, com: [0, 0, 0] }
	const at = (k: "xMm" | "yMm" | "zMm") => ms.reduce((t, m) => t + m[k] * m.massG, 0) / massG
	return { massG, com: [at("xMm"), at("yMm"), at("zMm")] }
}

// Where the rover touches the floor: the two wheel contacts and the caster's.
export function supportPolygon(mech: Mechanics, _cat: MechCatalog): [number, number][] {
	const d = mech.drive
	return [[d.axleXMm, d.trackMm / 2], [d.axleXMm, -d.trackMm / 2], [d.axleXMm - d.wheelbaseMm, 0]]
}
