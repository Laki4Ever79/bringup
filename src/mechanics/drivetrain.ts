// The drive train's bought mechanical parts (backlog, 15 Nov 2026, d9610c: "along with fasteners we should add gears,
// belts, chains and all other mechanical pieces"): gears, pulleys and belts, sprockets and chains, bearings, shafts,
// couplers, lead screws and their nuts. Each part names what it mates with; the checks below are plain code and say
// which numbers disagree, by how much, and what to change. Millimetres, teeth and links throughout.
//
// Formulas (standard machine design; e.g. Shigley's Mechanical Engineering Design, ch. 13 gears and 17 flexible
// elements):
//   gear pitch diameter d = m·z; a mesh's centre distance a = m(z1 + z2)/2.
//   pulley or sprocket pitch diameter D = p·z/π (exact for a belt's pitch line; a chain's is p/sin(180°/z)).
//   open belt length L = 2C + π(D1 + D2)/2 + (D2 − D1)²/(4C).
//   chain length in pitches Lp = 2C/p + (z1 + z2)/2 + p((z2 − z1)/2π)²/C.

export type DriveTrainPart =
	| { id: string; kind: "shaft"; diameterMm: number; lengthMm: number; rpm?: number; radialLoadN?: number; mpn?: string }
	| { id: string; kind: "gear"; module: number; teeth: number; boreMm: number; shaft: string; mpn?: string }
	| { id: string; kind: "mesh"; gears: [string, string]; centreMm: number }
	| { id: string; kind: "pulley"; pitchMm: number; teeth: number; boreMm: number; shaft: string; mpn?: string }
	| { id: string; kind: "belt"; pitchMm: number; teeth: number; pulleys: [string, string]; centreMm: number; tensionTravelMm: number; mpn?: string }
	| { id: string; kind: "sprocket"; pitchMm: number; teeth: number; boreMm: number; shaft: string; mpn?: string }
	| { id: string; kind: "chain"; pitchMm: number; links: number; sprockets: [string, string]; centreMm: number; tensionTravelMm: number; mpn?: string }
	// seatMm: the printed seat's diameter the bearing presses into.
	| { id: string; kind: "bearing"; boreMm: number; outerMm: number; shaft: string; seatMm: number; ratedRpm?: number; ratedLoadN?: number; mpn?: string }
	| { id: string; kind: "coupler"; boresMm: [number, number]; shafts: [string, string]; mpn?: string }
	| { id: string; kind: "leadscrew"; diameterMm: number; leadMm: number; nut: string; mpn?: string }
	| { id: string; kind: "leadnut"; diameterMm: number; leadMm: number; mpn?: string }

export type DriveTrainKind = DriveTrainPart["kind"]

// A shaft in a bore: a slip fit to a sliding fit for a printed or bought hub, a few hundredths either way
// (estimate: bore fit ±0.05 mm, ISO 286 H7/g6 at 5–8 mm spans 0.004–0.027 mm; 0.05 allows a bought hub's tolerance).
export const BORE_FIT_MM = 0.05
// A bearing pressed into a printed seat: the seat 0–0.2 mm over the outer ring, since FDM holes print undersize
// (estimate: printed press fit 0–0.2 mm, common practice for PLA on a 0.4 mm nozzle).
export const SEAT_MIN_MM = 0
export const SEAT_MAX_MM = 0.2
// Two gears' centre distance off the ideal: backlash or binding (estimate: ±0.05 mm for printed or small bought gears).
export const MESH_TOLERANCE_MM = 0.05

export type MateViolation = { part: string; message: string }

const r2 = (n: number) => Math.round(n * 100) / 100

export function pitchDiameter(p: { pitchMm: number; teeth: number }): number {
	return (p.pitchMm * p.teeth) / Math.PI
}

export function beltLengthMm(d1: number, d2: number, centreMm: number): number {
	return 2 * centreMm + (Math.PI * (d1 + d2)) / 2 + (d2 - d1) ** 2 / (4 * centreMm)
}

export function chainLinks(p: number, z1: number, z2: number, centreMm: number): number {
	return (2 * centreMm) / p + (z1 + z2) / 2 + (p * ((z2 - z1) / (2 * Math.PI)) ** 2) / centreMm
}

// The centre distance at which a belt or chain of the given length sits, by bisection (length grows with the centre).
function centreFor(length: (c: number) => number, target: number, lo: number): number | null {
	let [a, b] = [lo, lo + 10_000]
	if (length(a) > target) return null
	for (let i = 0; i < 80; i++) {
		const m = (a + b) / 2
		if (length(m) < target) a = m
		else b = m
	}
	return (a + b) / 2
}

export function driveTrainChecks(parts: DriveTrainPart[]): MateViolation[] {
	const out: MateViolation[] = []
	const byId = new Map(parts.map((p) => [p.id, p]))
	const push = (part: string, message: string) => out.push({ part, message })
	const seen = new Set<string>()
	for (const p of parts) {
		if (seen.has(p.id)) push(p.id, `two drive-train parts are called "${p.id}": give each its own id`)
		seen.add(p.id)
	}
	const get = <K extends DriveTrainKind>(from: string, id: string, kind: K): Extract<DriveTrainPart, { kind: K }> | null => {
		const q = byId.get(id)
		if (!q) {
			push(from, `${from} mates with "${id}", which the drive train doesn't have: add it or fix the name`)
			return null
		}
		if (q.kind !== kind) {
			push(from, `${from} mates with ${id}, a ${q.kind}, where a ${kind} belongs`)
			return null
		}
		return q as Extract<DriveTrainPart, { kind: K }>
	}
	// Every hub on its shaft: the bore against the shaft's diameter.
	const onShaft = (p: { id: string; kind: string; boreMm: number; shaft: string }) => {
		const s = get(p.id, p.shaft, "shaft")
		if (s && Math.abs(p.boreMm - s.diameterMm) > BORE_FIT_MM)
			push(p.id, `${p.id} (${p.kind}) has a ${p.boreMm} mm bore on ${s.id}, a ${s.diameterMm} mm shaft: ${p.boreMm > s.diameterMm ? "loose" : "won't go on"} by ${r2(Math.abs(p.boreMm - s.diameterMm))} mm (fit ±${BORE_FIT_MM} mm, estimate). Pick a part with a ${s.diameterMm} mm bore, or a ${p.boreMm} mm shaft`)
	}
	for (const p of parts) {
		switch (p.kind) {
			case "gear":
			case "pulley":
			case "sprocket":
				onShaft(p)
				break
			case "mesh": {
				const [a, b] = [get(p.id, p.gears[0], "gear"), get(p.id, p.gears[1], "gear")]
				if (!a || !b) break
				if (a.module !== b.module) {
					push(p.id, `${a.id} (module ${a.module}) and ${b.id} (module ${b.module}) can't mesh: gears mesh only at the same module`)
					break
				}
				const ideal = (a.module * (a.teeth + b.teeth)) / 2
				if (Math.abs(p.centreMm - ideal) > MESH_TOLERANCE_MM)
					push(p.id, `${a.id} and ${b.id} (module ${a.module}, ${a.teeth} and ${b.teeth} teeth) mesh at ${r2(ideal)} mm between centres; the design puts them ${p.centreMm} mm apart (${p.centreMm > ideal ? "backlash" : "binding"}, ${r2(Math.abs(p.centreMm - ideal))} mm against ±${MESH_TOLERANCE_MM}, estimate). Move a shaft to ${r2(ideal)} mm`)
				break
			}
			case "belt": {
				const [a, b] = [get(p.id, p.pulleys[0], "pulley"), get(p.id, p.pulleys[1], "pulley")]
				if (!a || !b) break
				const off = [a, b].filter((q) => q.pitchMm !== p.pitchMm)
				if (off.length) {
					push(p.id, `${p.id} has a ${p.pitchMm} mm pitch; ${off.map((q) => `${q.id} has ${q.pitchMm} mm`).join(", ")}: a belt runs only on pulleys of its own pitch`)
					break
				}
				checkLoop(p.id, "belt", p.pitchMm * p.teeth, (c) => beltLengthMm(pitchDiameter(a), pitchDiameter(b), c), p.centreMm, p.tensionTravelMm, (pitchDiameter(a) + pitchDiameter(b)) / 2, "mm", (c) => `${r2(c)} mm`)
				break
			}
			case "chain": {
				const [a, b] = [get(p.id, p.sprockets[0], "sprocket"), get(p.id, p.sprockets[1], "sprocket")]
				if (!a || !b) break
				const off = [a, b].filter((q) => q.pitchMm !== p.pitchMm)
				if (off.length) {
					push(p.id, `${p.id} has a ${p.pitchMm} mm pitch; ${off.map((q) => `${q.id} has ${q.pitchMm} mm`).join(", ")}: a chain runs only on sprockets of its own pitch`)
					break
				}
				if (p.links % 2 !== 0) push(p.id, `${p.id} has ${p.links} links: an odd count needs an offset link, which weakens the chain; use ${p.links + 1}`)
				checkLoop(p.id, "chain", p.links, (c) => chainLinks(p.pitchMm, a.teeth, b.teeth, c), p.centreMm, p.tensionTravelMm, (pitchDiameter(a) + pitchDiameter(b)) / 2, "links", (c) => `${r2(c)} links`)
				break
			}
			case "bearing": {
				onShaft(p)
				const over = r2(p.seatMm - p.outerMm)
				if (over < SEAT_MIN_MM - 1e-9 || over > SEAT_MAX_MM + 1e-9)
					push(p.id, `${p.id}'s printed seat is ${p.seatMm} mm for a ${p.outerMm} mm outer ring (${over >= 0 ? "+" : ""}${over} mm): a printed press fit wants the seat ${SEAT_MIN_MM}–${SEAT_MAX_MM} mm over (estimate). Make the seat ${r2(p.outerMm + 0.1)} mm`)
				const s = byId.get(p.shaft)
				if (s?.kind === "shaft") {
					if (p.ratedRpm !== undefined && s.rpm !== undefined && s.rpm > p.ratedRpm) push(p.id, `${p.id} is rated ${p.ratedRpm} rpm; ${s.id} turns at ${s.rpm} rpm: pick a faster bearing or gear the shaft down`)
					if (p.ratedLoadN !== undefined && s.radialLoadN !== undefined && s.radialLoadN > p.ratedLoadN) push(p.id, `${p.id} is rated ${p.ratedLoadN} N; ${s.id} puts ${s.radialLoadN} N on it: pick a bigger bearing or share the load`)
				}
				break
			}
			case "coupler": {
				p.shafts.forEach((id, i) => {
					const s = get(p.id, id, "shaft")
					if (s && Math.abs(p.boresMm[i] - s.diameterMm) > BORE_FIT_MM)
						push(p.id, `${p.id}'s ${i === 0 ? "first" : "second"} bore is ${p.boresMm[i]} mm; ${s.id} is ${s.diameterMm} mm: pick a coupler with a ${s.diameterMm} mm bore on that side`)
				})
				break
			}
			case "leadscrew": {
				const n = get(p.id, p.nut, "leadnut")
				if (n && (n.leadMm !== p.leadMm || Math.abs(n.diameterMm - p.diameterMm) > BORE_FIT_MM))
					push(p.id, `${p.id} is ${p.diameterMm} mm with a ${p.leadMm} mm lead; its nut ${n.id} is ${n.diameterMm} mm with ${n.leadMm} mm: a nut fits only its own screw's diameter and lead`)
				break
			}
		}
	}
	return out

	// A belt or chain: its length sits at one centre distance; the design's centre must be within the tensioner's travel
	// of it (the travel takes up the difference), and never shorter than the pulleys need to clear each other.
	function checkLoop(id: string, what: string, have: number, length: (c: number) => number, centre: number, travel: number, minCentre: number, unit: string, fmt: (c: number) => string) {
		const fits = centreFor(length, have, minCentre)
		if (fits === null) {
			push(id, `${id} (${r2(have)} ${unit}) is too short to go round both at any centre distance: pick a longer ${what}`)
			return
		}
		const gap = r2(fits - centre)
		if (gap < -1e-9 || gap > travel + 1e-9)
			push(id, `${id} (${r2(have)} ${unit}) sits at ${r2(fits)} mm between centres; the design puts them ${centre} mm apart, ${gap < 0 ? `${-gap} mm too far: it won't go on` : `${gap} mm too close, past the ${travel} mm tension travel: it will be slack`} (at ${centre} mm it needs ${fmt(length(centre))}). Move a shaft, add travel, or pick another length`)
	}
}

// The shape the contract accepts for mechanics.driveTrain (optional): what an agent must write.
const FIELDS: Record<DriveTrainKind, string[]> = {
	shaft: ["diameterMm", "lengthMm"],
	gear: ["module", "teeth", "boreMm", "shaft"],
	mesh: ["gears", "centreMm"],
	pulley: ["pitchMm", "teeth", "boreMm", "shaft"],
	belt: ["pitchMm", "teeth", "pulleys", "centreMm", "tensionTravelMm"],
	sprocket: ["pitchMm", "teeth", "boreMm", "shaft"],
	chain: ["pitchMm", "links", "sprockets", "centreMm", "tensionTravelMm"],
	bearing: ["boreMm", "outerMm", "shaft", "seatMm"],
	coupler: ["boresMm", "shafts"],
	leadscrew: ["diameterMm", "leadMm", "nut"],
	leadnut: ["diameterMm", "leadMm"],
}
const REFS = new Set(["shaft", "nut"])
const PAIRS = new Set(["gears", "pulleys", "sprockets", "shafts"])
export const DRIVE_TRAIN_SHAPE = `driveTrain (optional) must be a list of {id, kind, ...}: ${Object.entries(FIELDS).map(([k, f]) => `${k}: ${f.join(", ")}`).join("; ")} (numbers in mm and teeth/links; shaft and nut name a part's id, gears/pulleys/sprockets/shafts two ids, boresMm two numbers; optional mpn, and rpm/radialLoadN on a shaft, ratedRpm/ratedLoadN on a bearing)`

export function driveTrainShapeError(v: unknown): string | null {
	if (v === undefined) return null
	if (!Array.isArray(v)) return DRIVE_TRAIN_SHAPE
	for (const p of v) {
		if (typeof p !== "object" || p === null || typeof (p as { id?: unknown }).id !== "string") return DRIVE_TRAIN_SHAPE
		const q = p as Record<string, unknown>
		const need = FIELDS[q.kind as DriveTrainKind]
		if (!need) return DRIVE_TRAIN_SHAPE
		for (const f of need) {
			const x = q[f]
			const ok = REFS.has(f) ? typeof x === "string" && x !== "" : PAIRS.has(f) ? Array.isArray(x) && x.length === 2 && x.every((y) => typeof y === "string") : f === "boresMm" ? Array.isArray(x) && x.length === 2 && x.every((y) => typeof y === "number" && y > 0) : typeof x === "number" && Number.isFinite(x) && x >= 0
			if (!ok) return `${DRIVE_TRAIN_SHAPE}; ${q.id} (${q.kind}) has a bad or missing ${f}`
		}
	}
	return null
}
