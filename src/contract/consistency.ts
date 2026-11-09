import { dutyCycleCheckLines, estimatePower } from "./power.ts"
import { linkChecks, type LinkViolation } from "./links.ts"
import { connectorBoxes, downloadStrap, generatedNets, MIC_PORT, moduleBlocked, partPads, recoveryBootPin, recoveryPads, sharesBootPin, supportParts, usbWake } from "../codegen/circuit.ts"
import { mcuCurrents, regulatorRating } from "./power.ts"
import { DEFAULT_PERIOD_S, HISTORY_CAPACITY_BYTES, HISTORY_RECORD_BYTES, sensorDriver } from "../codegen/firmware.ts"
import { enclosureMode, type AgentRole, type Connector, type ContractSnapshot, type FieldName } from "./types.ts"
import { modelChecks, type ModelViolation } from "./model.ts"
import { fixtureChecks, testChecks, type TestViolation } from "./testkit.ts"
import { builtFeatureChecks, caseChecks, MIN_WALL_MM, SLOT_MARGIN_MM, type BuiltFeature, type CaseViolation } from "./case.ts"
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
	| "boot-pin-taken"
	| "usb-wake-pin-taken"
	| "button-unreachable"
	| "field-missing"
	| "connector-clash"
	| "module-blocked"
	| "download-pin-low"
	| "led-pin"
	| "rail-underrated"
	| ModelViolation["kind"]
	| TestViolation["kind"]
	| CaseViolation["kind"]
	| SpaceViolation["kind"]
	| ConnectivityViolation["kind"]
	| LinkViolation["kind"]

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
	v.push(...unconnectedParts(c), ...connectorsWithoutParts(c), ...bootPinTaken(c), ...downloadPinLow(c), ...usbWakePinTaken(c), ...unreachableButtons(c), ...connectorClashes(c), ...moduleEdgeBlocked(c), ...ledOnCathode(c), ...underratedRails(c), ...modelChecks(c), ...testChecks(c), ...fixtureChecks(c, a.board, a.testkit), ...caseChecks(c), ...builtFeatureChecks(c, a.enclosure), ...spaceChecks(c), ...connectivityChecks(c), ...linkChecks(c))
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

// A deep-sleeping design needs its MCU's boot pin free (an I2C line may share it): the board generator puts the recovery
// BOOT pad there, and a signal on it would also decide how the chip boots (real run 3, 7 Nov: no way to reflash a
// sleeping board). And the pads need room on the bottom.
export function bootPinTaken(c: ContractSnapshot): Violation[] {
	const boot = recoveryBootPin(c)
	const taken = boot ? (c.values.pins ?? []).filter((p) => p.gpio === boot.gpio && !sharesBootPin(p.signal)) : []
	if (!boot) return []
	const { unplaced } = taken.length === 0 && c.values.outline ? recoveryPads(c) : { unplaced: [] }
	if (unplaced.length > 0)
		return [
			{
				kind: "boot-pin-taken",
				message: `the recovery pads (${unplaced.join(", ")}) find no free spot on the bottom of the ${c.values.outline!.widthMm}×${c.values.outline!.heightMm} mm board, so a deep-sleeping board could not be reflashed: make the board larger or move parts`,
				fields: ["outline", "parts"],
				affects: ["architect"],
			},
		]
	if (taken.length === 0) return []
	return [
		{
			kind: "boot-pin-taken",
			message: `${boot.mcu.ref} ${boot.pin} is the boot strapping pin, held low at reset it starts the ROM downloader; the board generator puts the recovery BOOT pad there, since a deep-sleeping board has its USB off. It is assigned to ${taken.map((p) => `${p.signal} (${p.partRef}.${p.partPin})`).join(", ")}: move that to another GPIO (an I2C line, pulled up, may stay)`,
			fields: ["pins"],
			affects: ["architect"],
		},
	]
}

// Download boot needs the MCU's download strap (the ESP32-C3's GPIO8) high at reset; the generator pulls it up
// (circuit.ts downloadStrap). A signal that holds it low defeats the recovery pads: an LED (and the pull-up would light it
// through the LED all the time), or a line the generator pulls down.
export function downloadPinLow(c: ContractSnapshot): Violation[] {
	const strap = downloadStrap(c)
	const on = strap && (c.values.pins ?? []).find((p) => p.gpio === strap.gpio)
	if (!strap || !on) return []
	const part = (c.values.parts ?? []).find((p) => p.ref === on.partRef)
	const led = part && (part.role === "led" || part.role === "charge-led")
	const pulledDown = supportParts(c).some((sp) => sp.b && "net" in sp.b && sp.b.net === "GND" && "net" in sp.a && sp.a.net === on.signal)
	if (!led && !pulledDown) return []
	return [{
		kind: "download-pin-low",
		message: `${strap.mcu.ref} ${strap.pin} must read high at reset for the recovery pads to start the ROM downloader (ESP32-C3 TRM v1.4, Table 7.2-1), so the board generator pulls it up; it is assigned to ${on.signal} (${on.partRef}.${on.partPin}), ${led ? "an LED, which holds it low at reset (and the pull-up would light the LED through deep sleep)" : "a line the generator pulls down"}: move ${on.signal} to another GPIO. A button to GND, a UART line or an I2C line may stay`,
		fields: ["pins"],
		affects: ["architect"],
	}]
}

// USB wake needs a free deep-sleep wake pin for the VBUS sense (codegen/circuit.ts usbWake); without one, a sleeping
// board can't be reflashed with the cable alone.
export function usbWakePinTaken(c: ContractSnapshot): Violation[] {
	const wake = usbWake(c)
	if (!wake || wake.gpio !== null) return []
	return [
		{
			kind: "usb-wake-pin-taken",
			message: `USB wake needs one free deep-sleep wake pin for the VBUS sense (${wake.free.map((g) => `GPIO${g}`).join(", ")} on ${wake.mcu.ref}; GPIO2 is a strapping pin), and the pins use all of them: move a signal that doesn't wake the chip to another GPIO. Only the engineer may turn USB wake off (requirements.usbWake false); then reflashing a sleeping board needs the case open and the recovery pads`,
			fields: ["pins"],
			affects: ["architect"],
		},
	]
}

// Connectors that crowd each other at the board's edge: their footprints overlap, or (with our case) their openings leave
// less than the case's minimum wall between them. Before, only the builds found it ("overlapping slots", "courtyard of
// SW1 overlaps"), and the architect read a build failure instead of the two refs (real system run, 9 Nov).
export function connectorClashes(c: ContractSnapshot): Violation[] {
	const o = c.values.outline
	const connectors = c.values.connectors ?? []
	if (!o || connectors.length < 2) return []
	const boxes = connectorBoxes(c, o.widthMm, o.heightMm)
	const out: Violation[] = []
	for (let i = 0; i < connectors.length; i++)
		for (let j = i + 1; j < connectors.length; j++) {
			const [a, b] = [connectors[i], connectors[j]]
			const [ba, bb] = [boxes.find((x) => x.ref === a.ref), boxes.find((x) => x.ref === b.ref)]
			const footprints = ba && bb && Math.abs(ba.x - bb.x) < (ba.w + bb.w) / 2 && Math.abs(ba.y - bb.y) < (ba.h + bb.h) / 2
			const span = (k: Connector) => [k.offsetMm - k.widthMm / 2 - SLOT_MARGIN_MM, k.offsetMm + k.widthMm / 2 + SLOT_MARGIN_MM]
			const [sa, sb] = [span(a), span(b)]
			const gap = Math.max(sb[0] - sa[1], sa[0] - sb[1])
			const openings = enclosureMode(c.values) === "case" && a.edge === b.edge && gap < MIN_WALL_MM
			if (!footprints && !openings) continue
			out.push({
				kind: "connector-clash",
				message: `${a.ref} (${a.edge}@${a.offsetMm} mm) and ${b.ref} (${b.edge}@${b.offsetMm} mm) ${footprints ? "overlap on the board" : `leave ${Math.max(0, gap).toFixed(1)} mm of case wall between their openings, under the ${MIN_WALL_MM} mm minimum`}: move one along its edge or to another edge`,
				fields: ["connectors"],
				affects: ["architect"],
			})
		}
	return out
}

// The module has no spot at its edge (moduleBlocked): told before any build, with what is in the way, so the architect
// moves a connector instead of growing the board.
export function moduleEdgeBlocked(c: ContractSnapshot): Violation[] {
	const m = moduleBlocked(c)
	if (!m || !c.values.outline) return []
	const conns = c.values.connectors ?? []
	const { widthMm: W, heightMm: H } = c.values.outline
	// For each connector in the way, the nearest offset on its edge that leaves the module a spot, found by trying them:
	// "move it along" alone left the beacon's SW1 at top@35–40 mm, still in the way, until the board grew (system run 5).
	const fix = (k: Connector): string => {
		const len = k.edge === "left" || k.edge === "right" ? H : W
		const fits: number[] = []
		for (let off = k.widthMm / 2 + 1; off <= len - k.widthMm / 2 - 1; off += 0.5) {
			const moved = conns.map((x) => (x.ref === k.ref ? { ...x, offsetMm: off } : x))
			if (!moduleBlocked({ ...c, values: { ...c.values, connectors: moved } })) fits.push(off)
		}
		if (fits.length === 0) return `${k.ref} (${k.edge}@${k.offsetMm} mm): no spot on the ${k.edge} edge clears it, so move it to another edge`
		const best = fits.reduce((a, b) => (Math.abs(b - k.offsetMm) < Math.abs(a - k.offsetMm) ? b : a))
		return `${k.ref} (${k.edge}@${k.offsetMm} mm): ${k.edge}@${best} mm is the nearest spot that clears it`
	}
	const inWay = m.blockers.map((r) => conns.find((x) => x.ref === r)!).filter(Boolean)
	const what = inWay.length > 0 ? `in the way: ${inWay.map(fix).join("; ")}. Move ${inWay.length > 1 ? "them" : "it"}` : "the mounting holes at its corners leave no room. Lengthen that edge"
	return [{
		kind: "module-blocked",
		message: `${m.ref} (the radio module) only goes at the ${m.edge} edge, opposite ${m.usbRef ? `USB-C ${m.usbRef}` : "the USB-C edge"}, its antenna past the edge: it needs ${m.needMm} mm of that ${m.edgeMm} mm edge clear, ${m.depthMm} mm deep; ${what} before making the board bigger`,
		fields: ["connectors", "outline"],
		affects: ["architect"],
	}]
}

// A status LED's GPIO goes on its anode: the generator puts its resistor from the cathode to GND, so a GPIO on the
// cathode leaves the anode unconnected and the LED never lights (real system run 1, 9 Nov: STATUS_LED on D1.K).
export function ledOnCathode(c: ContractSnapshot): Violation[] {
	const parts = c.values.parts ?? []
	return (c.values.pins ?? [])
		.filter((p) => p.partPin === "K" && parts.some((x) => x.ref === p.partRef && x.role === "led"))
		.map((p) => ({ kind: "led-pin" as const, message: `${p.signal} drives ${p.partRef}'s cathode (K), but the board generator puts the LED's resistor from K to GND, so its anode is unconnected and it never lights: assign ${p.signal} to ${p.partRef}.A`, fields: ["pins"] as FieldName[], affects: ["architect"] as AgentRole[] }))
}

// A button someone has to press needs a way to reach it. In our case, that is an opening: the button listed in connectors
// on the edge it is pressed from, so the case cuts one (real run 5, 9 Nov: a wake button sealed inside a closed case,
// and the review passed it). A bare board needs nothing; in the engineer's own housing it is on the interface drawing.
export function unreachableButtons(c: ContractSnapshot): Violation[] {
	if (enclosureMode(c.values) !== "case") return []
	const listed = new Set((c.values.connectors ?? []).map((k) => k.ref))
	return (c.values.parts ?? [])
		.filter((p) => p.role === "button" && !listed.has(p.ref))
		.map((p) => ({
			kind: "button-unreachable" as const,
			message: `${p.ref} (${p.mpn}) is a button inside a closed case, with no opening to press it through: list it in connectors (kind "button", on the edge it is pressed from) so the case cuts one, or remove it if the brief doesn't need it`,
			fields: ["connectors", "parts"] as FieldName[],
			affects: ["architect"] as AgentRole[],
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
