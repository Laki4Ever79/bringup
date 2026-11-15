// The pure geometry and limits of an assembly that both the server's checks (src/system/assembly.ts, checks.ts) and
// the design page's edit model (system-edit.js) need, in one place: this module is browser JS, and the TypeScript side
// imports it, so the two never drift. Frame: +x forward, +y left, origin at the plate centre, positions are centres.

// A routed cable is cut this much longer than its route, for the bends at both plugs.
export const CABLE_SLACK_MM = 40

export function cableLength(points) {
	let sum = 0
	for (let i = 1; i < points.length; i++) sum += Math.hypot(points[i].xMm - points[i - 1].xMm, points[i].yMm - points[i - 1].yMm)
	return sum
}

// Size along x and y once the rotation is applied (a quarter turn swaps them).
export function footprint(b) {
	const turned = b.rotDeg === 90 || b.rotDeg === 270
	return turned ? { xMm: b.outline.heightMm, yMm: b.outline.widthMm } : { xMm: b.outline.widthMm, yMm: b.outline.heightMm }
}

// Boards that only touch edge to edge don't overlap.
export function boardsOverlap(p, q) {
	const fp = footprint(p), fq = footprint(q)
	return Math.abs(p.xMm - q.xMm) < (fp.xMm + fq.xMm) / 2 && Math.abs(p.yMm - q.yMm) < (fp.yMm + fq.yMm) / 2
}

// True when the board's footprint sticks out of the plate.
export function offPlate(b, plate) {
	const f = footprint(b)
	return Math.abs(b.xMm) + f.xMm / 2 > plate.lengthMm / 2 || Math.abs(b.yMm) + f.yMm / 2 > plate.widthMm / 2
}

// Figures behind the electrical checks. The wire's resistance is copper's; the capacitances are ESTIMATES for an
// untwisted 28 AWG JST SH cable.
export const CABLE_PF_PER_M = 50 // estimate
export const BOARD_PF = 10 // estimate: pins, pads and traces on each board
export const DEVICE_PF = 5 // estimate: each other device on the bus
export const PULLUP_OHM = 10_000 // the board generator's I2C pull-ups (codegen/circuit.ts SUPPORT.pullup)
// I2C rise-time limits (I2C specification, standard and fast mode); rise time ~ 0.8473 x R x C.
const RISE_NS = (khz) => (khz > 100 ? 300 : 1000)

// The longest cable an I2C bus allows at this speed with the generator's pull-ups (estimate: the cable's pF/m), and the
// capacitance budget it comes from. `devices` counts the I2C devices on the bus besides the two boards' own pins.
export function i2cCableLimit(khz, devices) {
	const fixedPf = 2 * BOARD_PF + devices * DEVICE_PF
	const maxPf = (RISE_NS(khz) * 1e-9) / (0.8473 * PULLUP_OHM) / 1e-12
	return { maxPf, maxMm: Math.max(0, ((maxPf - fixedPf) / CABLE_PF_PER_M) * 1000) }
}
