import { dutyCycleCheckLines, estimatePower } from "./power.ts"
import { generatedNets, MIC_PORT, partPads, supportParts } from "../codegen/circuit.ts"
import { mcuCurrents, regulatorRating } from "./power.ts"
import { DEFAULT_PERIOD_S, HISTORY_CAPACITY_BYTES, HISTORY_RECORD_BYTES, sensorDriver } from "../codegen/firmware.ts"
import type { AgentRole, Connector, ContractSnapshot, FieldName } from "./types.ts"
import { modelChecks, type ModelViolation } from "./model.ts"
import { fixtureChecks, testChecks, type TestViolation } from "./testkit.ts"
import { builtFeatureChecks, caseChecks, type BuiltFeature, type CaseViolation } from "./case.ts"
import type { CaseFeature } from "./types.ts"
import { spaceChecks, type SpaceViolation } from "./space.ts"
import { connectivityChecks, radioPeakMa, type ConnectivityViolation } from "./connectivity.ts"
import type { TestPoint } from "../codegen/circuit.ts"

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
	// Openings through the floor under bottom-port microphones, measured from the built case.
	ports?: { ref: string; xMm: number; yMm: number; diameterMm: number }[]
	// The case field's features as built, each measured on the solid (contract/case.ts BuiltFeature).
	features?: BuiltFeature[]
	// The case field's features the build was given: the built ones are compared only while these are current.
	featuresAsked?: CaseFeature[]
}

export interface FirmwareArtifact {
	revision: number
	ok: boolean
	pins: Record<string, number>
	// The sensor driver compiled in (SENSOR_* in pins.h), null for none; absent on artifacts that don't record it.
	sensor?: string | null
	log: string
}

// The production-test kit (contract field test): the plan, the bed-of-nails fixture and the factory-test firmware,
// built together from one revision.
export interface TestkitArtifact {
	revision: number
	dir: string
	// The probes the fixture has, where the board generator put each test pad.
	probes: TestPoint[]
	planPath: string
	fixtureStlPath: string | null
	fixtureStepPath: string | null
	// The factory-test firmware (env esp32c3_test): compiled against this revision's pins.h.
	firmware: { ok: boolean; log: string; pins: Record<string, number> }
	// What py/fixture.py found wrong with the fixture it built (a blocked probe hole), or why it wasn't built.
	fixtureIssues: string[]
}

export interface Artifacts {
	board?: BoardArtifact
	enclosure?: EnclosureArtifact
	firmware?: FirmwareArtifact
	testkit?: TestkitArtifact
}

export type ViolationKind =
	| "drc-errors"
	| "outline-mismatch"
	| "net-missing"
	| "pin-mismatch"
	| "cutout-missing"
	| "cutout-misaligned"
	| "standoff-mismatch"
	| "part-mismatch"
	| "rail-overload"
	| "regulator-overclaimed"
	| "firmware-build-failed"
	| "sensor-mismatch"
	| "history-overflow"
	| "vent-missing"
	| "port-missing"
	| "sensor-unwired"
	| "battery-short"
	| "part-unconnected"
	| "connector-without-part"
	| "rail-underrated"
	| ModelViolation["kind"]
	| TestViolation["kind"]
	| CaseViolation["kind"]
	| SpaceViolation["kind"]
	| ConnectivityViolation["kind"]

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
// A floor opening counts as under the sound hole when the hole is within its radius plus this.
const PORT_TOLERANCE_MM = 0.5
// An M2 screw through a 2.2 mm hole forgives about 0.3 mm of misplacement.
const STANDOFF_TOLERANCE_MM = 0.3
// A post within this distance of an unmatched hole is reported as that hole's post, moved.
const MOUNTING_PAIR_MM = 5

// Plain-code check of every artifact against the contract. Each rule runs only when its inputs exist,
// so a half-built design reports what is wrong so far rather than what is missing.
// brief: the product brief, for the battery capacity it states; without it, requirements.batteryMah.
export function checkConsistency(c: ContractSnapshot, a: Artifacts, brief = ""): Violation[] {
	const v: Violation[] = []
	v.push(...unconnectedParts(c), ...connectorsWithoutParts(c), ...underratedRails(c), ...modelChecks(c), ...testChecks(c), ...fixtureChecks(c, a.board, a.testkit), ...caseChecks(c), ...builtFeatureChecks(c, a.enclosure), ...spaceChecks(c), ...connectivityChecks(c))
	// Battery life, live: when even the contract's own stated averages (the optimistic figure) fall short of its
	// battery-life target, the design can't meet it; the architect hears it during design, not at the final review.
	const power = estimatePower(c, brief)
	if (power.days !== null && power.targetDays !== null && power.days < power.targetDays) {
		const check = dutyCycleCheckLines(power, c).find((l) => l.startsWith("- Average"))
		v.push({
			kind: "battery-short",
			message: `the stated rail averages give ${Math.round(power.days)} days of battery life, short of the ${power.targetDays}-day target${power.wifi ? `, with Wi-Fi uploads adding ${Number(power.wifi.averageMa.toPrecision(3))} mA (${power.wifi.how})` : ""}${check ? `; the duty-cycle check gives ${check.replace(/^- Average /, "an average of ")}` : ""}`,
			// Wi-Fi uploads are the connectivity engineer's lever (a longer upload period), as much as the architect's.
			fields: power.wifi ? ["requirements", "rails", "parts", "connectivity"] : ["requirements", "rails", "parts"],
			affects: power.wifi ? ["architect", "connectivity"] : ["architect"],
		})
	}
	const { outline, pins, parts, connectors, rails } = c.values

	// KiCad's DRC found errors, or nets left unrouted, on the board built at this size: the architect decides (the
	// engineer, 6 Nov 2026). A built board of another size is a rebuild under way, not this board's fault.
	const drc = a.board?.drc
	if (a.board && outline && drc && (drc.errors > 0 || drc.unconnected > 0) && Math.abs(a.board.widthMm - outline.widthMm) <= OUTLINE_TOLERANCE_MM && Math.abs(a.board.heightMm - outline.heightMm) <= OUTLINE_TOLERANCE_MM) {
		v.push({
			kind: "drc-errors",
			message: `the ${outline.widthMm}×${outline.heightMm} mm board (rev ${a.board.revision}) fails ${drc.rules}: ${drc.errors} error(s), ${drc.unconnected} unconnected${drc.firstError ? `; first: ${drc.firstError}` : ""}. Give the router room (a bigger board, with outline.sizeReason "routing" naming this build) or change what crowds it (connectors, pins)`,
			fields: ["outline", "connectors", "pins"],
			affects: ["architect"],
		})
	}
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

	// The firmware is generated from the contract (pins.h), so a pin or sensor-driver mismatch only means it hasn't been
	// rebuilt yet: the builder fixes it, and no agent is woken (an agent would "fix" the contract to match a stale build).
	if (a.firmware && pins) {
		for (const pin of pins) {
			const built = a.firmware.pins[pin.signal]
			if (built !== pin.gpio) {
				v.push({
					kind: "pin-mismatch",
					message: `firmware drives ${pin.signal} on GPIO${built ?? "?"}, contract says GPIO${pin.gpio}`,
					fields: ["pins"],
					affects: [],
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
				affects: [],
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

	// A bottom-port microphone hears through the PCB: the case needs an opening under its sound hole, where the built
	// board put it.
	const ports = a.enclosure?.ports
	if (ports) {
		for (const mic of (parts ?? []).filter((p) => p.role === "microphone")) {
			const port = ports.find((x) => x.ref === mic.ref)
			const at = a.board?.placements?.[mic.ref]
			const hole = at && { x: at.xMm + MIC_PORT.x, y: at.yMm + MIC_PORT.y }
			const under = port && (!hole || Math.hypot(hole.x - port.xMm, hole.y - port.yMm) <= port.diameterMm / 2 + PORT_TOLERANCE_MM)
			if (under) continue
			const where = hole ? ` at (${+hole.x.toFixed(1)}, ${+hole.y.toFixed(1)}) mm` : ""
			v.push({ kind: "port-missing", message: `case has no opening under the microphone ${mic.ref}'s sound hole${where}${port ? `; its opening is at (${+port.xMm.toFixed(1)}, ${+port.yMm.toFixed(1)}) mm` : ""}`, fields: ["parts"], affects: ["enclosure"] })
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
		// The rating a rail claims is the architect's number; the regulator part has its own. A claim above the part's
		// rating made every load check below it meaningless (an XC6206 rated 200 mA could be written as 600).
		const ldo = parts?.find((p) => p.role === "ldo")
		const rating = ldo && Math.abs(rail.voltageV - 3.3) < 0.05 ? regulatorRating(ldo) : null
		if (rating && rail.regulatorMaxMa > rating.maxMa) {
			v.push({
				kind: "regulator-overclaimed",
				message: `${rail.name} claims a ${rail.regulatorMaxMa} mA regulator, but ${ldo!.ref} ${ldo!.mpn} is rated ${rating.maxMa} mA (${rating.source})`,
				fields: ["rails", "parts"],
				affects: ["architect"],
			})
		}
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
	// Only once the pin map exists: before the architect has assigned any pins, nothing is "unwired" yet, and waking
	// the architect then would only interrupt its first design.
	for (const sensor of pins === undefined ? [] : (parts ?? []).filter((p) => p.role === "sensor")) {
		const unwired = ["SDA", "SCL"].filter((bus) => sensor.pins.includes(bus) && !(pins ?? []).some((p) => p.partRef === sensor.ref && p.partPin === bus))
		if (unwired.length > 0) v.push({ kind: "sensor-unwired", message: `sensor ${sensor.ref} (${sensor.mpn}) has no GPIO on ${unwired.join(", ")}`, fields: ["pins"], affects: ["architect"] })
	}

	return v
}

// A connector that is nothing: no part of its ref, no contract pin on it, and no net the board generator wires to it.
// The board still places a footprint for it and the case cuts its opening, for nothing (real run 7 Nov: the button
// connector SW1 stayed after the button was dropped, and the case kept a hole for it). A connector the generator wires
// (USB-C J1 with no part entry) is not one of these.
export function connectorsWithoutParts(c: ContractSnapshot): Violation[] {
	const parts = c.values.parts ?? []
	if (parts.length === 0 || !c.values.pins?.length) return []
	const used = usedRefs(c)
	return (c.values.connectors ?? [])
		.filter((k) => !used.has(k.ref) && !parts.some((p) => p.ref === k.ref))
		.map((k) => ({
			kind: "connector-without-part" as const,
			message: `connector ${k.ref} (${k.kind ?? "connector"}, ${k.edge} edge) has no part, no pin and no generated wiring, but the board still places it and the case cuts an opening for it: add the part and its pin, or remove the connector`,
			fields: ["connectors", "parts"] as FieldName[],
			affects: ["architect", "parts"] as AgentRole[],
		}))
}

// Every ref something connects: a contract pin, a net the board generator wires, or a support part's end.
function usedRefs(c: ContractSnapshot): Set<string> {
	const used = new Set<string>((c.values.pins ?? []).map((p) => p.partRef))
	for (const ends of generatedNets(c).values()) for (const end of ends) used.add(end.split(".")[0])
	for (const sp of supportParts(c)) {
		if (!sp.added) used.add(sp.ref)
		for (const end of [sp.a, sp.b]) if ("ref" in end) used.add((end as { ref: string }).ref)
	}
	return used
}

// A part in the list that nothing connects: no contract pin uses it and the board generator wires no net or support
// part to it. It would sit on the board doing nothing, e.g. a second LED meant to show charging state but given role
// "led" instead of "charge-led" (real beacon run K: the reviewer found CHRG unconnected at the final review).
export function unconnectedParts(c: ContractSnapshot): Violation[] {
	const parts = c.values.parts ?? []
	// Only once both lists exist: parts are usually written before the pins that use them.
	if (parts.length === 0 || !c.values.pins?.length) return []
	const used = usedRefs(c)
	const wanted = [...new Set(supportParts(c).map((sp) => `${sp.spec.value} ${sp.spec.lcsc}`))].join(", ")
	return parts
		.filter((p) => !used.has(p.ref))
		.map((p) => ({
			kind: "part-unconnected" as const,
			message: `${p.ref} ${p.mpn} (role ${p.role}) is connected to nothing: no contract pin uses it and the board generator wires nothing to it${p.role === "resistor" || p.role === "capacitor" ? ` (it adds its own passives and reuses a contract part only with the same LCSC number: ${wanted}); remove it or use one of those` : p.role === "led" ? "; a charging-state LED needs role charge-led" : ""}`,
			fields: ["parts", "pins"] as FieldName[],
			affects: ["architect"] as AgentRole[],
		}))
}

// A 3.3 V rail whose peak is below what the MCU itself draws with its radio on (datasheet): the regulator would be
// sized for less than the chip needs (real beacon run M: 80 mA against the ESP32-C3's 84 mA receiving).
// The 3V3 rail's stated peak must cover the radio's transmit peak (connectivity.radio: Bluetooth LE or Wi-Fi), from the
// module's datasheet. Before, it was checked against the radio's receive current, since the chip datasheet gave no
// Bluetooth LE figure; the module datasheet v2.2 does, and transmitting at 0 dBm peaks at twice the receive current.
export function underratedRails(c: ContractSnapshot): Violation[] {
	const peak = radioPeakMa(c)
	if (!peak) return []
	return (c.values.rails ?? [])
		.filter((r) => Math.abs(r.voltageV - 3.3) < 0.05 && r.loadMa < peak.ma)
		.map((r) => ({
			kind: "rail-underrated" as const,
			message: `rail ${r.name} is sized for a ${r.loadMa} mA peak, below ${peak.ma} mA with ${peak.what} (${peak.source})`,
			fields: ["rails", "parts"] as FieldName[],
			affects: ["architect"] as AgentRole[],
		}))
}
