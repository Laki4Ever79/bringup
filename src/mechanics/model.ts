import { byMpn, type BatteryPack, type MechCatalog, type MotorPart } from "./catalog.ts"
// The beacon support's flat top, printed solid, and the beacon's centre of mass above it (ESTIMATE: half an 80 mm-tall
// beacon; Eurobot General Rules 1.2 F.6 sets only its mass, 400 g with its tag, and the 430 mm top it sits on).
export const BEACON_TOP_MM = 3
export const BEACON_LOAD_HALF_MM = 40
import { ESTOP_HEAD_CLEARANCE_MM, ESTOP_PANEL_MM } from "./safety.ts"
// The deck's wall, as py/chassis.py WALL.
const DECK_WALL_MM = 2
import { est } from "./estimates.ts"
import type { Mechanics, Mount } from "./types.ts"
import { hatBaseZ } from "../dashboard/assembly-geom.js"

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

// The drive's load line, one model for the firmware's cruise duty, the "Top speed" and "Cruise duty" checks and the
// simulation (py/mech/model.py motor_torque, battery_volts): on a flat floor each wheel carries half the rolling load
// T = Crr·m·g·r/2, which draws i = T/kt through the winding, so at duty d on supply V the wheel turns at
// ω = (d·V − i·R)/ke. The pack's terminal voltage sags by both motors' current through its internal resistance.
export function rollingLoadNmPerWheel(massKg: number, wheelRadiusM: number): number {
	return (est("rollingCrr") * massKg * G * wheelRadiusM) / 2
}
export const packOhm = (pack: BatteryPack) => pack.internalOhm ?? est("packInternalOhm")
function loadLine(motor: MotorPart, pack: BatteryPack, openV: number, massKg: number, wheelRadiusM: number) {
	const m = motorAt(motor, openV)
	const loadA = m.kt > 0 ? rollingLoadNmPerWheel(massKg, wheelRadiusM) / m.kt : 0
	return { m, loadA, volts: openV - 2 * loadA * packOhm(pack) }
}
// The wheel's ground speed at `duty` from a pack whose open-circuit voltage is openV.
export function loadedSpeedMps(motor: MotorPart, pack: BatteryPack, openV: number, duty: number, massKg: number, wheelRadiusM: number): number {
	const { m, loadA, volts } = loadLine(motor, pack, openV, massKg, wheelRadiusM)
	return m.ke > 0 ? Math.max(0, ((duty * volts - loadA * m.rOhm) / m.ke) * wheelRadiusM) : 0
}
// The duty that holds speedMps on the load line from a pack at openV (unclamped: above 1 the motor can't reach it).
export function dutyFor(motor: MotorPart, pack: BatteryPack, openV: number, speedMps: number, massKg: number, wheelRadiusM: number): number {
	const { m, loadA, volts } = loadLine(motor, pack, openV, massKg, wheelRadiusM)
	return volts > 0 ? ((speedMps / wheelRadiusM) * m.ke + loadA * m.rOhm) / volts : Infinity
}
// The firmware's cruise duty. The rover has no battery sense (no divider on an ADC pin), so the duty is a fixed PWM;
// it is set for a full pack, where the rover runs fastest and where the simulated drive starts (soc 1). The speed it
// plans is then the most it ever goes: the stop distance and the quarter turn timed at that speed hold on a fresh pack
// and err short, never long, as the pack drains (at the nominal plateau it runs about nominalV/fullV of it, 0.88 for a
// LiPo). Set at the nominal voltage, a fresh pack ran 1.135× fast and the timed turn overshot.
export function cruiseDuty(motor: MotorPart, pack: BatteryPack, speedMps: number, massKg: number, wheelRadiusM: number): number {
	return dutyFor(motor, pack, pack.fullV, speedMps, massKg, wheelRadiusM)
}
// Under this cruise duty the gearmotor is geared too fast for the target: little torque in hand at that duty (stalled,
// a wheel gives duty × its stall torque) and the speed set by a few PWM steps. It used to be a silent floor in the
// firmware (the duty raised to 0.3), which ran a badly geared rover up to 1.4× its planned speed and timed its turns
// wrong; the "Cruise duty" check names it to the mechanics engineer instead.
export const MIN_CRUISE_DUTY = 0.3

// Braking: only the drive wheels grip the floor (floorMu); the caster slides at its own casterMu (the simulation's
// caster contact), so it barely brakes. Deceleration g·(μ·onWheels + μc·(1 − onWheels)), with the weight split as
// standing (braking moves weight forward onto the front wheels, so this errs long). The firmware's stop distance, the
// "Stopping distance" and "Tipping margin" checks all use it.
export function brakeDecel(onWheels: number): number {
	return G * (est("floorMu") * onWheels + est("casterMu") * (1 - onWheels))
}
// The deceleration (and acceleration) the robot actually sees: the floor's, or less where the firmware ramps the duty
// (mechanics.drive.maxAccelMps2).
export function drivenDecel(onWheels: number, maxAccelMps2?: number): number {
	return Math.min(brakeDecel(onWheels), maxAccelMps2 ?? Infinity)
}
export function brakeMm(speedMps: number, onWheels: number, maxAccelMps2?: number): number {
	return ((speedMps ** 2) / (2 * drivenDecel(onWheels, maxAccelMps2))) * 1000
}
// Turning in place: the rover pivots on its axle's midpoint, so its footprint sweeps a circle as far as its farthest
// point from there (a plate corner, usually the rear one, or a wheel's outer edge).
export function turnSweepMm(mech: Mechanics, wheel: { diameterMm: number; widthMm: number }): number {
	const d = mech.drive, [L, W] = mech.chassis.plateMm
	const plate = [L / 2 - d.axleXMm, -L / 2 - d.axleXMm].map((dx) => Math.hypot(dx, W / 2))
	const wheels = Math.hypot(wheel.diameterMm / 2, d.trackMm / 2 + wheel.widthMm / 2)
	return Math.max(...plate, wheels)
}
// After an open-loop quarter turn the rover drives on beside the wall it turned from, a few degrees off parallel; the
// next turn in place must not sweep into it. This much beyond the sweep (a design margin, measured on the rover-pi's
// simulated drive, 15 Nov: its pivot moved 35 mm toward the wall while turning from forward motion, and drifted 30 mm
// more over 0.7 m at 2° off parallel; 50 mm still hit, 100 mm cleared by 33 mm).
export const TURN_CLEARANCE_MM = 100
// The sensor reading at which the rover must start a turn in place so its sweep clears the wall ahead and the one it
// will drive beside: the pivot stands sweep + clearance from the wall, the sensor is sensorAheadMm in front of the pivot.
export function turnStopMm(mech: Mechanics, wheel: { diameterMm: number; widthMm: number }): number {
	return turnSweepMm(mech, wheel) + TURN_CLEARANCE_MM - (mech.sensor.at.xMm - mech.drive.axleXMm)
}

// The share of the weight on the drive wheels (moments about the caster, wheelbaseMm behind the axle).
export function onWheelsShare(d: { axleXMm: number; wheelbaseMm: number }, comXMm: number): number {
	const casterX = d.axleXMm - d.wheelbaseMm
	return Math.min(1, Math.max(0, (comXMm - casterX) / (d.axleXMm - casterX)))
}

// The payload the brief carries, on the plate's centre 10 mm up (the checks, the firmware and the chassis spec agree).
export function payloadMount(mech: Mechanics, payloadG: number): Mount {
	return { what: "payload", xMm: 0, yMm: 0, zMm: mech.chassis.clearanceMm + mech.chassis.thicknessMm + 10, sizeMm: [20, 20, 20], massG: payloadG }
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
// The sticker panel's box (py/chassis.py prints the same): STICKER_PANEL_MM thick at the plate's edge on its face,
// STICKER_MARGIN_MM wider and taller than the sticker's space, from the plate's top. Null without one.
export const STICKER_PANEL_MM = 2
export const STICKER_MARGIN_MM = 2
export function stickerPanel(mech: Mechanics): Omit<Mount, "massG"> | null {
	const k = mech.sticker
	if (!k) return null
	const [L, W] = mech.chassis.plateMm
	const along = k.widthMm + 2 * STICKER_MARGIN_MM, up = k.heightMm + 2 * STICKER_MARGIN_MM
	const z = mech.chassis.clearanceMm + mech.chassis.thicknessMm + up / 2
	const t = STICKER_PANEL_MM
	if (k.face === "front" || k.face === "rear") return { what: "sticker-panel", xMm: (k.face === "front" ? 1 : -1) * (L / 2 - t / 2), yMm: 0, zMm: z, sizeMm: [t, along, up] }
	return { what: "sticker-panel", xMm: 0, yMm: (k.face === "left" ? 1 : -1) * (W / 2 - t / 2), zMm: z, sizeMm: [along, t, up] }
}

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
	const sensor = byMpn(cat.sensors ?? [], mech.sensor?.module ?? "")
	if (sensor && mech.sensor) out.push({ what: "sensor", xMm: mech.sensor.at.xMm, yMm: mech.sensor.at.yMm, zMm: mech.sensor.at.zMm, sizeMm: [sensor.sizeMm[2], sensor.sizeMm[0], sensor.sizeMm[1]], massG: sensor.massG })
	// The emergency stop, its head above the panel and its body below (safety.ts).
	const estop = mech.safety?.estop ? byMpn(cat.safety ?? [], mech.safety.estop.part) : undefined
	if (estop && mech.safety?.estop) {
		const e = mech.safety.estop
		out.push({ what: "estop", xMm: e.at.xMm, yMm: e.at.yMm, zMm: e.at.zMm + (estop.aboveMm - estop.belowMm) / 2, sizeMm: [estop.headMm, estop.headMm, estop.aboveMm + estop.belowMm], massG: estop.massG })
		// Its printed deck (py/chassis.py, chassis.ts ChassisEstop): two walls at the plate's long edges, the panel across
		// the plate and the collar ring, in PLA. The same geometry the chassis prints; the cutout is left in (a little heavy).
		const ringIn = estop.headMm / 2 + ESTOP_HEAD_CLEARANCE_MM, span = 2 * (ringIn + DECK_WALL_MM), panel = Math.min(estop.panelMaxMm, Math.max(estop.panelMinMm, ESTOP_PANEL_MM))
		const wallH = Math.max(0, e.at.zMm - panel - plateTop)
		const collar = e.collarMm ?? 0
		const mm3 = 2 * span * DECK_WALL_MM * wallH + span * c.plateMm[1] * panel + Math.PI * ((ringIn + DECK_WALL_MM) ** 2 - ringIn ** 2) * collar
		out.push({ what: "estop-deck", xMm: e.at.xMm, yMm: 0, zMm: e.at.zMm - (panel + wallH) / 2, sizeMm: [span, c.plateMm[1], wallH + panel + collar], massG: (mm3 * est("plaDensityGcm3")) / 1000 })
	}
	// A beacon support (Eurobot F.6): the printed mast, PLA, from the plate to its top, and the load on its top (the
	// opponent's beacon: its centre of mass an ESTIMATE, BEACON_LOAD_HALF_MM above the top).
	if (mech.beacon) {
		const b = mech.beacon, h = Math.max(0, b.topMm - plateTop)
		const mm3 = 4 * b.sizeMm * b.mastWallMm * h + b.sizeMm * b.sizeMm * BEACON_TOP_MM
		out.push({ what: "beacon-mast", xMm: b.at.xMm, yMm: b.at.yMm, zMm: plateTop + h / 2, sizeMm: [b.sizeMm, b.sizeMm, h], massG: (mm3 * est("plaDensityGcm3")) / 1000 })
		out.push({ what: "beacon-load", xMm: b.at.xMm, yMm: b.at.yMm, zMm: b.topMm + BEACON_LOAD_HALF_MM, sizeMm: [80, 80, 2 * BEACON_LOAD_HALF_MM], massG: b.loadG })
	}
	// A sticker panel (mechanics.sticker): a flat printed plate standing at the plate's edge.
	const panel = stickerPanel(mech)
	if (panel) out.push({ ...panel, massG: (panel.sizeMm[0] * panel.sizeMm[1] * panel.sizeMm[2] * est("plaDensityGcm3")) / 1000 })
	// A HAT (`on`) stands on its board's spacers (hatBaseZ), the others on the plate's standoffs.
	const onPlate = plateTop + est("standoffMm")
	for (const b of c.boards) {
		const info = boards.find((x) => x.name === b.name)
		if (!info) continue
		const turned = b.rotDeg === 90 || b.rotDeg === 270
		const w = turned ? info.outline.heightMm : info.outline.widthMm, h = turned ? info.outline.widthMm : info.outline.heightMm
		const base = b.on && c.boards.some((x) => x.name === b.on && !x.on) ? hatBaseZ(onPlate) : onPlate
		out.push({ what: `board:${b.name}`, xMm: b.at.xMm, yMm: b.at.yMm, zMm: base + 0.8, sizeMm: [w, h, 1.6], massG: info.massG ?? ((w * h) / 100) * est("boardMassGPerCm2") })
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
