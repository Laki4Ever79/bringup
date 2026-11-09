// The shapes the contract accepts for motion and mechanics (contract.ts shapeError): what an agent must write.
const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const num = (v: unknown, min = 0) => typeof v === "number" && Number.isFinite(v) && v >= min
const pair = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every((x) => num(x, 1))

export function motionShapeError(v: unknown): string | null {
	const shape = "motion must be {speedMps > 0, runtimeMin > 0, edgeMm ≥ 0, maxSlopeDeg ≥ 0, stopBeforeWallMm ≥ 0, payloadG ≥ 0, maxSizeMm: [length, width], maxMassG > 0}"
	if (!obj(v)) return shape
	const ok = num(v.speedMps) && (v.speedMps as number) > 0 && num(v.runtimeMin) && (v.runtimeMin as number) > 0 && num(v.edgeMm) && num(v.maxSlopeDeg) && num(v.stopBeforeWallMm) && num(v.payloadG) && pair(v.maxSizeMm) && num(v.maxMassG) && (v.maxMassG as number) > 0
	return ok ? null : shape
}

export function mechanicsShapeError(v: unknown): string | null {
	const shape =
		'mechanics must be {drive: {kind: "differential", motor, wheel, caster (catalog/mechanics.json mpns), trackMm, wheelbaseMm, axleXMm}, battery: {pack (mpn), at: {xMm, yMm}}, sensor: {module (catalog sensors mpn), at: {xMm, yMm, zMm}, connector (board connector ref)}, chassis: {plateMm: [length, width], thicknessMm, material: "PLA", clearanceMm, boards: [{name, at: {xMm, yMm}, rotDeg: 0|90|180|270}]}} (mm; origin at the plate centre, +x forward)'
	if (!obj(v) || !obj(v.drive) || !obj(v.battery) || !obj(v.chassis) || !obj(v.sensor)) return shape
	const d = v.drive, b = v.battery, c = v.chassis, s = v.sensor
	const at = (p: unknown) => obj(p) && typeof p.xMm === "number" && typeof p.yMm === "number"
	const ok =
		d.kind === "differential" && [d.motor, d.wheel, d.caster].every((x) => typeof x === "string" && x) && num(d.trackMm, 1) && num(d.wheelbaseMm, 1) && typeof d.axleXMm === "number" &&
		typeof b.pack === "string" && at(b.at) &&
		typeof s.module === "string" && at(s.at) && typeof (s.at as Record<string, unknown>).zMm === "number" && typeof s.connector === "string" &&
		pair(c.plateMm) && num(c.thicknessMm, 0.5) && c.material === "PLA" && num(c.clearanceMm) &&
		Array.isArray(c.boards) && c.boards.every((x) => obj(x) && typeof x.name === "string" && at(x.at) && [0, 90, 180, 270].includes(x.rotDeg as number))
	return ok ? null : shape
}
