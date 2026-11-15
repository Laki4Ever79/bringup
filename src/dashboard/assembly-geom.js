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

// Boards that only touch edge to edge don't overlap. A carrier and the bought board it carries stack (one over the
// other on the same holes): they don't overlap either.
export function boardsOverlap(p, q) {
	if ((p.carries && p.carries === q.name) || (q.carries && q.carries === p.name)) return false
	const fp = footprint(p), fq = footprint(q)
	return Math.abs(p.xMm - q.xMm) < (fp.xMm + fq.xMm) / 2 && Math.abs(p.yMm - q.yMm) < (fp.yMm + fq.yMm) / 2
}

// True when the board's footprint sticks out of the plate.
export function offPlate(b, plate) {
	const f = footprint(b)
	return Math.abs(b.xMm) + f.xMm / 2 > plate.lengthMm / 2 || Math.abs(b.yMm) + f.yMm / 2 > plate.widthMm / 2
}

// The plate and placement rules of a robot's chassis (src/mechanics/checks.ts, mech-fit): the mechanics checks call
// these, and the design page's editor runs them on every move. A mount is {xMm, yMm, zMm?, sizeMm: [x, y, z?]} in the
// chassis frame, its position its centre.
// Each wheel's inner face keeps this much from the plate's edge.
export const WHEEL_CLEARANCE_MM = 2
// True when the wheels' inner faces come closer than the clearance to the plate's long edges.
export function wheelsRubPlate(plateWidthMm, trackMm, wheelWidthMm) {
	return trackMm / 2 - wheelWidthMm / 2 < plateWidthMm / 2 + WHEEL_CLEARANCE_MM
}
// The widest plate the wheels allow: the track less one wheel and the clearance on both sides.
export const plateMaxWidthMm = (trackMm, wheelWidthMm) => trackMm - wheelWidthMm - 2 * WHEEL_CLEARANCE_MM
// The biggest plate a brief's outer size allows (motion.maxSizeMm): its width less the two wheels beside the plate and
// their clearance, as plateLimitMm in src/mechanics/checks.ts. Without a wheel width, the brief's own size.
export const plateLimitForBrief = (maxSizeMm, wheelWidthMm) => (wheelWidthMm ? [maxSizeMm[0], maxSizeMm[1] - 2 * wheelWidthMm - 2 * WHEEL_CLEARANCE_MM] : [maxSizeMm[0], maxSizeMm[1]])
// How far a motor's body reaches in under the plate, across the plate (y); its bracket needs at least half its body there.
export const motorUnderPlateMm = (plateWidthMm, m) => plateWidthMm / 2 - (Math.abs(m.yMm) - m.sizeMm[1] / 2)
export const motorHalfUnder = (plateWidthMm, m) => !(motorUnderPlateMm(plateWidthMm, m) < m.sizeMm[1] / 2)
// True when the mount's footprint lies on the plate (edge to edge included).
export function mountOnPlate(m, lengthMm, widthMm) {
	return Math.abs(m.xMm) + m.sizeMm[0] / 2 <= lengthMm / 2 + 1e-9 && Math.abs(m.yMm) + m.sizeMm[1] / 2 <= widthMm / 2 + 1e-9
}
// The distance sensor looks forward (+x): true when the mount stands wholly ahead of it, across its width, and reaches
// up past its bottom.
export function blocksSensor(m, sensor) {
	return m.xMm - m.sizeMm[0] / 2 > sensor.xMm && Math.abs(m.yMm - sensor.yMm) < (m.sizeMm[1] + sensor.sizeMm[1]) / 2 && m.zMm + m.sizeMm[2] / 2 > sensor.zMm - sensor.sizeMm[2] / 2
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

// A board's standoffs: the default height, the range the assembly allows (an error outside it) and the usual range (a
// warning outside it).
export const STANDOFF_DEFAULT_MM = 8
export const STANDOFF_RANGE_MM = [3, 30]
export const STANDOFF_USUAL_MM = [5, 20]

// JSON with object keys sorted and undefined fields left out, so the page and the server write a value the same way.
export function canonicalJson(v) {
	if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`
	if (v && typeof v === "object") return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`
	return JSON.stringify(v ?? null)
}
// The design an edit was made from (its assembly and links), as a short hash: Apply sends it as `base`, and the
// requests endpoint refuses an edit made from a design that has changed since. FNV-1a, two 32-bit lanes (not secure;
// it only tells two designs apart).
export function designHash(d) {
	const s = canonicalJson({ assembly: d?.assembly ?? null, links: d?.links ?? [] })
	let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i)
		h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
		h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0
	}
	return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")
}
