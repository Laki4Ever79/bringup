import { partPads } from "../codegen/circuit.ts"
import { DEFAULT_PERIOD_S, HISTORY_CAPACITY_BYTES, HISTORY_RECORD_BYTES, sensorDriver } from "../codegen/firmware.ts"
import type { AgentRole, Connector, ContractSnapshot, FieldName } from "./types.ts"

export interface BoardArtifact {
	revision: number
	dir: string
	pcbPath: string
	stepPath: string | null
	renderPath: string | null
	widthMm: number
	heightMm: number
	// net name -> "REF.pinName" entries
	nets: Record<string, string[]>
	// KiCad design-rule check against the fab's rules (null when KiCad could not run).
	drc?: import("../tools/drc.ts").DrcSummary | null
	// The JLC/PCBWay fab package (gerbers.zip, bom.csv, cpl.csv, README.txt), or why it could not be exported.
	// Best-effort: a failed export never fails the board build.
	fabDir?: string
	fabError?: string
	// Drilled mounting holes, from the board's bottom-left corner (read from tscircuit's circuit.json).
	holes?: { xMm: number; yMm: number; diameterMm: number }[]
	// What was placed, by reference designator (circuit.json): the MPN (null when the board has none) and the pins.
	parts?: Record<string, { mpn: string | null; pins: string[] }>
	// Where each part's centre was placed, from the board's bottom-left corner (circuit.json).
	placements?: Record<string, { xMm: number; yMm: number }>
}

export interface PrintCheck {
	ok: boolean
	issues: string[]
}

export interface EnclosureArtifact {
	revision: number
	stlPath: string
	stepPath: string
	cutouts: { ref: string; edge: Connector["edge"]; offsetMm: number; widthMm: number; heightMm: number; zMm?: number }[]
	// Measured from the built case, from the board's bottom-left corner; holeMm is the screw pilot hole.
	standoffs?: { xMm: number; yMm: number; holeMm: number }[]
	lidStlPath?: string
	lidStepPath?: string
	printCheck?: PrintCheck
	// Slot vents in the lid, one per sensor, measured from the built lid: centre from the board's bottom-left corner and
	// the grille's size. Absent on cases built before vents existed.
	vents?: { ref: string; xMm: number; yMm: number; widthMm: number; heightMm: number }[]
}

export interface FirmwareArtifact {
	revision: number
	ok: boolean
	pins: Record<string, number>
	// The sensor driver compiled in (SENSOR_* in pins.h), null for none; absent on artifacts that don't record it.
	sensor?: string | null
	log: string
}

export interface Artifacts {
	board?: BoardArtifact
	enclosure?: EnclosureArtifact
	firmware?: FirmwareArtifact
}

export type ViolationKind =
	| "outline-mismatch"
	| "net-missing"
	| "pin-mismatch"
	| "cutout-missing"
	| "cutout-misaligned"
	| "standoff-mismatch"
	| "part-mismatch"
	| "rail-overload"
	| "firmware-build-failed"
	| "sensor-mismatch"
	| "history-overflow"
	| "vent-missing"
	| "sensor-unwired"

export interface Violation {
	kind: ViolationKind
	message: string
	fields: FieldName[]
	affects: AgentRole[]
}

const OUTLINE_TOLERANCE_MM = 0.1
const CUTOUT_TOLERANCE_MM = 0.5
// A sensor counts as vented when its centre lies under the grille or within this distance of its edge.
const VENT_TOLERANCE_MM = 1
// An M2 screw through a 2.2 mm hole forgives about 0.3 mm of misplacement.
const STANDOFF_TOLERANCE_MM = 0.3
// A post within this distance of an unmatched hole is reported as that hole's post, moved.
const MOUNTING_PAIR_MM = 5

// Plain-code check of every artifact against the contract. Each rule runs only when its inputs exist,
// so a half-built design reports what is wrong so far rather than what is missing.
export function checkConsistency(c: ContractSnapshot, a: Artifacts): Violation[] {
	const v: Violation[] = []
	const { outline, pins, parts, connectors, rails } = c.values

	if (a.board && outline) {
		if (Math.abs(a.board.widthMm - outline.widthMm) > OUTLINE_TOLERANCE_MM || Math.abs(a.board.heightMm - outline.heightMm) > OUTLINE_TOLERANCE_MM) {
			v.push({
				kind: "outline-mismatch",
				message: `board is ${a.board.widthMm}×${a.board.heightMm} mm, contract says ${outline.widthMm}×${outline.heightMm} mm`,
				fields: ["outline"],
				affects: ["board"],
			})
		}
	}

	const mcuRef = parts?.find((p) => p.role === "mcu")?.ref
	if (a.board && pins && mcuRef) {
		for (const pin of pins) {
			const net = a.board.nets[pin.signal] ?? []
			const mcuEnd = `${mcuRef}.GPIO${pin.gpio}`
			// On a USB-C connector the pin lands on numbered pads (J1.DN on pin9 and pin11): any of them counts.
			const pads = partPads(parts?.find((p) => p.ref === pin.partRef), pin.partPin).map((pad) => `${pin.partRef}.${pad}`)
			const missing = [...(net.includes(mcuEnd) ? [] : [mcuEnd]), ...(pads.some((end) => net.includes(end)) ? [] : [`${pin.partRef}.${pin.partPin}`])]
			if (missing.length > 0) {
				v.push({
					kind: "net-missing",
					message: `net ${pin.signal} does not connect ${missing.join(", ")}`,
					fields: ["pins"],
					affects: ["board"],
				})
			}
		}
	}

	if (a.firmware && pins) {
		for (const pin of pins) {
			const built = a.firmware.pins[pin.signal]
			if (built !== pin.gpio) {
				v.push({
					kind: "pin-mismatch",
					message: `firmware drives ${pin.signal} on GPIO${built ?? "?"}, contract says GPIO${pin.gpio}`,
					fields: ["pins"],
					affects: ["firmware"],
				})
			}
		}
	}

	const sensor = (c.values.parts ?? []).find((p) => p.role === "sensor")
	if (a.firmware && a.firmware.sensor !== undefined && sensor) {
		const wanted = sensorDriver(sensor.mpn)
		if (a.firmware.sensor !== wanted) {
			v.push({
				kind: "sensor-mismatch",
				message: `firmware reads the sensor with the ${a.firmware.sensor ?? "no"} driver, contract's ${sensor.ref} is ${sensor.mpn} (${wanted ?? "no driver"})`,
				fields: ["parts"],
				affects: ["firmware"],
			})
		}
	}

	// The history depth the architect claims has to fit the firmware's flash partition at the reading period.
	const historyDays = c.values.requirements?.historyDays
	if (a.firmware && historyDays !== undefined) {
		const periodS = c.values.requirements?.dutyCycle?.periodS ?? DEFAULT_PERIOD_S
		const bytes = Math.ceil((historyDays * 86400) / periodS) * HISTORY_RECORD_BYTES
		if (bytes > HISTORY_CAPACITY_BYTES) {
			const mb = (n: number) => `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)} MB`
			v.push({
				kind: "history-overflow",
				message: `requirements.historyDays: ${historyDays} days at ${periodS} s is ${mb(bytes)} of readings; the firmware's LittleFS partition holds ${mb(HISTORY_CAPACITY_BYTES)}`,
				fields: ["requirements"],
				affects: ["architect"],
			})
		}
	}

	if (a.firmware && !a.firmware.ok) {
		v.push({ kind: "firmware-build-failed", message: "firmware does not compile", fields: ["pins", "parts"], affects: ["firmware"] })
	}

	if (a.enclosure && connectors) {
		for (const conn of connectors) {
			const cut = a.enclosure.cutouts.find((x) => x.ref === conn.ref)
			if (!cut) {
				v.push({ kind: "cutout-missing", message: `enclosure has no cutout for ${conn.ref}`, fields: ["connectors"], affects: ["enclosure"] })
			} else if (
				cut.edge !== conn.edge ||
				Math.abs(cut.offsetMm - conn.offsetMm) > CUTOUT_TOLERANCE_MM ||
				cut.widthMm < conn.widthMm ||
				cut.heightMm < conn.heightMm
			) {
				v.push({
					kind: "cutout-misaligned",
					message: `cutout for ${conn.ref} is ${cut.edge}@${cut.offsetMm} mm ${cut.widthMm}×${cut.heightMm}, connector is ${conn.edge}@${conn.offsetMm} mm ${conn.widthMm}×${conn.heightMm}`,
					fields: ["connectors"],
					affects: ["enclosure"],
				})
			}
		}
	}

	// A temperature/humidity sensor sealed in the case measures the box, not the room: each needs a vent over it. Where
	// the board placed the sensor is the truth when the board is built; without it, a vent named for the sensor counts.
	const vents = a.enclosure?.vents
	if (vents) {
		for (const sensor of (parts ?? []).filter((p) => p.role === "sensor")) {
			const vent = vents.find((x) => x.ref === sensor.ref)
			const at = a.board?.placements?.[sensor.ref]
			const covers = vent && (!at || (Math.abs(at.xMm - vent.xMm) <= vent.widthMm / 2 + VENT_TOLERANCE_MM && Math.abs(at.yMm - vent.yMm) <= vent.heightMm / 2 + VENT_TOLERANCE_MM))
			if (covers) continue
			const where = at ? ` at (${+at.xMm.toFixed(1)}, ${+at.yMm.toFixed(1)}) mm` : ""
			const nearest = vent ? `; its vent is at (${+vent.xMm.toFixed(1)}, ${+vent.yMm.toFixed(1)}) mm` : ""
			v.push({ kind: "vent-missing", message: `case has no vent over the sensor ${sensor.ref}${where}${nearest}`, fields: ["parts"], affects: ["enclosure"] })
		}
	}

	// The board sits on the case's standoffs: every hole needs a post under it, and every post a hole over it.
	const holes = a.board?.holes
	const posts = a.enclosure?.standoffs
	if (holes && posts && posts.length + holes.length > 0) {
		const near = (p: { xMm: number; yMm: number }, q: { xMm: number; yMm: number }) => Math.hypot(p.xMm - q.xMm, p.yMm - q.yMm) <= STANDOFF_TOLERANCE_MM
		const at = (p: { xMm: number; yMm: number }) => `(${+p.xMm.toFixed(2)}, ${+p.yMm.toFixed(2)}) mm`
		const lonePosts = posts.filter((p) => !holes.some((h) => near(p, h)))
		const mismatch = (message: string) => v.push({ kind: "standoff-mismatch", message, fields: ["outline", "connectors"], affects: ["enclosure"] })
		for (const h of holes.filter((h) => !posts.some((p) => near(p, h)))) {
			// A post that moved is one finding, not a lone hole plus a lone post.
			const dist = (p: { xMm: number; yMm: number }) => Math.hypot(p.xMm - h.xMm, p.yMm - h.yMm)
			const nearest = lonePosts.filter((p) => dist(p) <= MOUNTING_PAIR_MM).sort((p, q) => dist(p) - dist(q))[0]
			if (nearest) {
				lonePosts.splice(lonePosts.indexOf(nearest), 1)
				mismatch(`standoff at ${at(nearest)} is ${dist(nearest).toFixed(2)} mm off the board hole at ${at(h)}`)
			} else mismatch(`board hole at ${at(h)} has no standoff under it`)
		}
		for (const p of lonePosts) mismatch(`standoff at ${at(p)} has no board hole over it`)
	}

	// The board must carry the contract's parts list: every part placed, and the same part (by MPN) where it says.
	const placed = a.board?.parts
	if (placed && parts) {
		for (const p of parts) {
			const got = placed[p.ref]
			const message = !got
				? `board has no ${p.ref} (${p.mpn})`
				: got.mpn !== null && got.mpn.toLowerCase() !== p.mpn.toLowerCase()
					? `board places ${got.mpn} as ${p.ref}, contract says ${p.mpn}`
					: null
			if (message) v.push({ kind: "part-mismatch", message, fields: ["parts"], affects: ["board"] })
		}
	}

	for (const rail of rails ?? []) {
		if (rail.loadMa > rail.regulatorMaxMa) {
			v.push({
				kind: "rail-overload",
				message: `${rail.name} draws ${rail.loadMa} mA, regulator is rated ${rail.regulatorMaxMa} mA`,
				fields: ["rails", "parts"],
				affects: ["architect", "parts"],
			})
		}
	}

	// A sensor is only useful on its bus: each of its SDA/SCL pins needs a GPIO in the pins field. (A real run's review
	// removed the I2C pins, and the sensor part came back without them.)
	for (const sensor of (parts ?? []).filter((p) => p.role === "sensor")) {
		const unwired = ["SDA", "SCL"].filter((bus) => sensor.pins.includes(bus) && !(pins ?? []).some((p) => p.partRef === sensor.ref && p.partPin === bus))
		if (unwired.length > 0) v.push({ kind: "sensor-unwired", message: `sensor ${sensor.ref} (${sensor.mpn}) has no GPIO on ${unwired.join(", ")}`, fields: ["pins"], affects: ["architect"] })
	}

	return v
}
