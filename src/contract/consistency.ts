import type { DriveArtifact } from "../tools/drive.ts"
import { boardMountChecks, type ChassisArtifact } from "../tools/chassis.ts"
import { hardwareChecks } from "../tools/robot-parts.ts"
import { defaultCheckCatalog, mechanicsChecks, type MechViolation } from "../mechanics/checks.ts"
import { byMpn } from "../mechanics/catalog.ts"
import { motionBriefChecks } from "../mechanics/brief.ts"
import { dutyCycleCheckLines, estimatePower } from "./power.ts"
import { linkChecks, type LinkViolation } from "./links.ts"
import { powerTree, VIN_OR_NET, connectorAlongMm, connectorBoxes, connectorExtents, downloadStrap, generatedNets, MAX_TRACK_MM, netName, supplyPours, supplyWidths, MIC_PORT, moduleBlocked, partPads, recoveryBootPin, recoveryPads, sharesBootPin, supportParts, usbWake } from "../codegen/circuit.ts"
import { mcuCurrents, regulatorRating } from "./power.ts"
import { DEFAULT_PERIOD_S, HISTORY_CAPACITY_BYTES, HISTORY_RECORD_BYTES, sensorDriver } from "../codegen/firmware.ts"
import { enclosureMode, type AgentRole, type Connector, type ContractSnapshot, type ContractValues, type FieldName } from "./types.ts"
import { modelChecks, type ModelViolation } from "./model.ts"
import { fixtureChecks, testChecks, type TestViolation } from "./testkit.ts"
import { builtFeatureChecks, caseChecks, MIN_WALL_MM, SLOT_MARGIN_MM, type BuiltFeature, type CaseViolation } from "./case.ts"
import type { CaseFeature } from "./types.ts"
import { blockedPins, spaceChecks, type SpaceViolation } from "./space.ts"
import { connectivityChecks, radioPeakMa, type ConnectivityViolation } from "./connectivity.ts"
import type { TestPoint } from "../codegen/circuit.ts"
import { mcuPinName } from "../mcu/pins.ts"

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
	// The debug footprint (codegen/circuit.ts debugPort) was in the contract but the board only built without it.
	debugPortDropped?: string
	// How many layouts the build tried before this one (each a full tscircuit build): the cost of the size.
	layoutsTried?: number
	// Who routed it: tscircuit (unset) or Freerouting, when no tscircuit layout routed (src/tools/freerouting.ts).
	routedBy?: "freerouting"
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
	// The motor and sensor drivers run on the host against simulated chips after a good build (tools/driver-tests.ts):
	// ok null when they couldn't run (no host compiler); absent on artifacts from before they existed.
	driverTests?: { ok: boolean | null; drivers: string[]; passed: number; failed: { name: string; message: string }[]; skipped?: string }
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
	chassis?: ChassisArtifact
	drive?: DriveArtifact
}

// The pins whose part isn't in the parts list yet: the architect writes the pins first (as told), and the parts agent
// may not have added the part they land on (the real rover, run 4, 15 Nov 2026: I2C_SDA on JT1.IO1 before JT1 existed).
export function pinPartsMissing(s: ContractSnapshot): { signal: string; ref: string; pin: string }[] {
	const refs = new Set((s.values.parts ?? []).map((p) => p.ref))
	return (s.values.pins ?? []).filter((p) => !refs.has(p.partRef)).map((p) => ({ signal: p.signal, ref: p.partRef, pin: p.partPin }))
}
// Pins written before the parts list has an MCU to put them on.
export function pinsWithoutMcu(s: ContractSnapshot): boolean {
	return (s.values.pins ?? []).length > 0 && !(s.values.parts ?? []).some((p) => p.role === "mcu")
}
// A build that stopped because the contract isn't complete yet: no design problem beyond the violation that names it,
// so it wakes no owner (src/agents/roles.ts); the build runs again when the contract changes.
export const WAITING_ON_CONTRACT = /^waiting on the contract:/

export type ViolationKind =
	| "drc-errors"
	| "outline-mismatch"
	| "net-missing"
	| "plug-without-edge"
	| "supply-unwired"
	| "pin-unwired"
	| "pin-part-missing"
	| "pin-mismatch"
	| "cutout-missing"
	| "cutout-misaligned"
	| "standoff-mismatch"
	| "part-mismatch"
	| "rail-overload"
	| "regulator-overclaimed"
	| "firmware-build-failed"
	| "board-mount-mismatch"
	| "hardware-misfit"
	| "firmware-driver-test-failed"
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
	| "part-net-unknown"
	| "net-short"
	| "rail-missing"
	| "rail-battery-source"
	| "rail-headroom"
	| "rail-unwired"
	| "rail-current-copper"
	| "pack-voltage"
	| "charger-pack"
	| "part-pinned-blocked"
	| "connector-off-edge"
	| ModelViolation["kind"]
	| TestViolation["kind"]
	| CaseViolation["kind"]
	| SpaceViolation["kind"]
	| ConnectivityViolation["kind"]
	| LinkViolation["kind"]
	| MechViolation["kind"]

export interface Violation {
	kind: ViolationKind
	message: string
	fields: FieldName[]
	affects: AgentRole[]
	// The datasheet numbers the check used and where each was read (mechanics checks today).
	sources?: { mpn: string; field: string; url: string; where: string }[]
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
// quick: the board page's per-move check, which leaves out the smallest-board search (spaceChecks).
export function checkConsistency(c: ContractSnapshot, a: Artifacts, brief = "", opts: { quick?: boolean } = {}): Violation[] {
	const v: Violation[] = []
	// A failed firmware-in-the-loop drive (docs/mechanics.md): the mechanics must change. "not run" (no QEMU, a stubbed
	// run) wakes nobody: the report says "not proven in simulation". Not the firmware reviewer: the rover's firmware is
	// generated from the contract, so its only lever was the pin map (real rover run 8, 15 Nov: it rewired pins on a
	// guess that the sensor was off the bus, and the next drive crawled at 0.09 m/s).
	if (a.drive?.result === "fail")
		v.push({ kind: "mech-drive", message: `the simulated drive failed: ${a.drive.reason}`, fields: ["mechanics"], affects: ["mechanics"] })
	v.push(...unconnectedParts(c), ...connectorsWithoutParts(c), ...plugsWithoutEdge(c), ...bootPinTaken(c), ...downloadPinLow(c), ...usbWakePinTaken(c), ...unreachableButtons(c), ...connectorClashes(c), ...connectorsOffEdge(c), ...pinnedBlocked(c), ...moduleEdgeBlocked(c), ...ledOnCathode(c), ...underratedRails(c), ...supplyWiring(c), ...packVoltage(c), ...modelChecks(c), ...testChecks(c), ...fixtureChecks(c, a.board, a.testkit), ...caseChecks(c), ...builtFeatureChecks(c, a.enclosure), ...spaceChecks(c, opts), ...connectivityChecks(c), ...linkChecks(c), ...mechanicsChecks(c), ...motionBriefChecks(c, brief))
	// A built chassis (not a stub) whose standoffs miss a board's mounting holes.
	if (a.chassis && !a.chassis.stub) v.push(...boardMountChecks(c, a.chassis.mounts as { standoffHoles?: { xMm: number; yMm: number }[] } | null))
	// Every fastener in the robot's parts list fits the hole it goes through (tools/robot-parts.ts).
	if (c.values.mechanics) v.push(...hardwareChecks(c))
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

	// Pins join MCU pins to parts: with no MCU in the parts yet (real rover run 10, revisions 14-15: the architect wrote
	// the pins, the parts agent hadn't added the MCU), the board can't be drawn. The parts owner adds it.
	if (pinsWithoutMcu(c))
		v.push({ kind: "pin-part-missing", message: `the pins (${(pins ?? []).length}) join MCU pins to parts, but the parts list has no MCU (role mcu): add it to the parts`, fields: ["parts", "pins"], affects: ["parts"] })
	for (const m of pinPartsMissing(c))
		v.push({ kind: "pin-part-missing", message: `${m.signal} goes to ${m.ref}.${m.pin}, but there is no part ${m.ref}: add it to the parts (or point the pin at the part that is there)`, fields: ["parts", "pins"], affects: ["parts"] })
	const mcuRef = parts?.find((p) => p.role === "mcu")?.ref
	// A pin assignment joins an MCU pin to the part pin it drives; one on the MCU's own pin goes nowhere, and its net,
	// with one end, fails every board build (the real architect's rover, run 1, 15 Nov 2026: DIST_TRIG on U1.GPIO2).
	if (pins && mcuRef)
		for (const pin of pins.filter((p) => p.partRef === mcuRef))
			v.push({
				kind: "pin-unwired",
				message: `${pin.signal} is on ${mcuRef}.${pin.partPin} and goes nowhere: a pin assignment joins the MCU pin to the part pin it drives (partRef that part, partPin its pin). Add the part or a connector for it, or drop ${pin.signal}`,
				fields: ["pins"],
				affects: ["architect"],
			})
	if (a.board && pins && mcuRef) {
		for (const pin of pins) {
			const net = a.board.nets[pin.signal] ?? []
			const mcuEnd = `${mcuRef}.${mcuPinName(parts, pin.gpio)}`
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

	// Every supply pin of every part is on a net in the board that was built, read from the board itself rather than from the
	// generator, which could be wrong the same way (run cc-eurobot-16, 16 Nov 2026: 13 boards were built with no V3V3 net, so
	// U1.3V3 was on nothing, and the net check, comparing with the same generator, saw nothing missing).
	if (a.board?.parts) {
		const onNet = new Set(Object.values(a.board.nets).filter((ends) => ends.length >= 2).flat())
		// A link connector's VCC when its link carries no power (supply "none"): the generator leaves it on nothing on purpose,
		// so two boards' supplies never meet (the scripted logger and beacon over UART, 17 Nov 2026: every system run ended
		// unsettled on JL1.VCC).
		const unpoweredByDesign = new Set((c.values.links ?? []).filter((l) => l.supply === "none").map((l) => `${l.connector}.VCC`))
		const unpowered = Object.entries(a.board.parts).flatMap(([ref, part]) => part.pins.filter((pin) => SUPPLY_PIN.test(pin) && !onNet.has(`${ref}.${pin}`) && !unpoweredByDesign.has(`${ref}.${pin}`)).map((pin) => `${ref}.${pin}`))
		if (unpowered.length)
			v.push({
				kind: "supply-unwired",
				message: `the built board leaves ${unpowered.join(", ")} on no net: ${unpowered.length === 1 ? "that supply pin has" : "those supply pins have"} no power. The rails field names the rails the board generator wires (a 3V3 rail for the MCU and its sensors, VBAT for the cell): add the missing rail`,
				fields: ["rails"],
				affects: ["architect"],
			})
	}

	// The firmware is generated from the contract (pins.h), so a pin or sensor-driver mismatch only means it hasn't been
	// rebuilt yet: the builder fixes it, and no agent is woken (an agent would "fix" the contract to match a stale build).
	if (a.firmware && pins) {
		for (const pin of pins) {
			const built = a.firmware.pins[pin.signal]
			if (built !== pin.gpio) {
				v.push({
					kind: "pin-mismatch",
					message: `firmware drives ${pin.signal} on ${built == null ? "?" : mcuPinName(parts, built)}, contract says ${mcuPinName(parts, pin.gpio)}`,
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
	if (a.firmware?.ok && a.firmware.driverTests?.ok === false) {
		const f = a.firmware.driverTests.failed
		v.push({ kind: "firmware-driver-test-failed", message: `firmware drivers fail on the host: ${f.map((x) => (x.message ? `${x.name} (${x.message})` : x.name)).join("; ")}`, fields: ["parts", "pins"], affects: ["firmware"] })
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

// The reverse, for the plug whose cable goes in sideways: a USB-C the connectors field places on no edge is put anywhere
// inside the board, where no cable reaches it (run cc-eurobot-17, 16 Nov 2026: no connectors field at all). A JST plug
// inside the board is fine, its cable comes from above (run 8's battery plug, reviewed and passed).
const PLUG_ROLES = new Set(["usb-c"])
export function plugsWithoutEdge(c: ContractSnapshot): Violation[] {
	const placed = new Set((c.values.connectors ?? []).map((k) => k.ref))
	const loose = (c.values.parts ?? []).filter((p) => PLUG_ROLES.has(p.role) && !placed.has(p.ref)).map((p) => p.ref)
	if (!loose.length) return []
	return [{
		kind: "plug-without-edge" as const,
		message: `${loose.join(", ")} ${loose.length === 1 ? "is a USB-C plug" : "are USB-C plugs"}, whose cable goes in from the side, but the connectors field places ${loose.length === 1 ? "it" : "them"} on no board edge, so the board would put ${loose.length === 1 ? "it" : "them"} inside where no cable reaches: add ${loose.length === 1 ? "it" : "each"} to connectors ({ref, kind, edge, offsetMm})`,
		fields: ["connectors"] as FieldName[],
		affects: ["architect"] as AgentRole[],
	}]
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
	// By the extent tscircuit judges (connectorExtents), so a corner's two connectors clear by their courtyards.
	const boxes = connectorExtents(c, o.widthMm, o.heightMm)
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

// A connector past the end of its edge (bringup-lead, 14 Nov 2026: the scripted rover compacted to 44×28 mm with JT1 at
// top@43 mm, and tscircuit refused the board minutes into its build). Along the edge, by the footprint's real extent
// (connectorBoxes), so a turned JST counts its 7 mm, not the 6 mm the contract lists.
export function connectorsOffEdge(c: ContractSnapshot): Violation[] {
	const o = c.values.outline
	if (!o || !c.values.connectors?.length) return []
	const [W, H] = [o.widthMm, o.heightMm]
	const boxes = connectorBoxes(c, W, H)
	return c.values.connectors.flatMap((k) => {
		const b = boxes.find((x) => x.ref === k.ref)
		if (!b) return []
		const alongX = k.edge === "top" || k.edge === "bottom"
		// Along the edge by the courtyard where it is longer than the box (connectorAlongMm): tscircuit judges that.
		const [centre, size, len] = alongX ? [b.x, connectorAlongMm(c, k.ref, b.w), W] : [b.y, connectorAlongMm(c, k.ref, b.h), H]
		const over = Math.abs(centre) + size / 2 - len / 2
		if (over <= 0.05) return []
		const half = Math.round((size / 2) * 10) / 10
		return [{
			kind: "connector-off-edge" as const,
			message: `${k.ref} (${k.edge}@${k.offsetMm} mm) runs ${over.toFixed(1)} mm past the end of the ${len} mm ${k.edge} edge: its footprint is ${size} mm along it, so its offset goes from ${half} to ${Math.round((len - half) * 10) / 10} mm; move it along the edge (a shrunk board keeps each connector's place in proportion)`,
			fields: ["connectors"] as FieldName[],
			affects: ["architect"] as AgentRole[],
		}]
	})
}

// The connectors moved along their edges so none runs past the end of its edge or overlaps another, or null when none
// does (or no packing helps). An outline change follows with this (rover run cc-rover-3, 15 Nov 2026: the architect
// shrank the board from 78x17 to 78x16 mm, left J5 at right@13.5 mm, 1 mm past the edge, and the run ended with it
// open; J5 moved alone then overlapped JM2 on the same 16 mm edge). Per edge, in order along it, each footprint is pushed
// inside the edge and clear of its neighbour (by the case's minimum wall when the openings share a case wall), moving
// each as little as that allows, in half millimetres; the checks themselves judge the result.
export function connectorsOntoEdges(c: ContractSnapshot): ContractValues["connectors"] | null {
	const o = c.values.outline
	if (!o || !c.values.connectors?.length) return null
	const problems = (connectors: Connector[]) => {
		const t = { ...c, values: { ...c.values, connectors } }
		return connectorsOffEdge(t).length + connectorClashes(t).length
	}
	const before = problems(c.values.connectors)
	if (before === 0) return null
	const gap = enclosureMode(c.values) === "case" ? MIN_WALL_MM : 0
	const boxAt = (connectors: Connector[], ref: string) => {
		const k = connectors.find((x) => x.ref === ref)!
		const b = connectorBoxes({ ...c, values: { ...c.values, connectors } }, o.widthMm, o.heightMm).find((x) => x.ref === ref)!
		const alongX = k.edge === "top" || k.edge === "bottom"
		return { centre: alongX ? b.x : b.y, size: connectorAlongMm(c, ref, alongX ? b.w : b.h) }
	}
	let connectors = c.values.connectors
	for (const edge of ["top", "bottom", "left", "right"] as const) {
		const len = edge === "top" || edge === "bottom" ? o.widthMm : o.heightMm
		// Each footprint as a span in the offset's own direction: p moves 1:1 with offsetMm.
		const spans = connectors.filter((k) => k.edge === edge).map((k) => {
			const a = boxAt(connectors, k.ref)
			const nudged = boxAt(connectors.map((x) => (x.ref === k.ref ? { ...x, offsetMm: x.offsetMm + 1 } : x)), k.ref)
			const dir = nudged.centre >= a.centre ? 1 : -1
			return { ref: k.ref, offset: k.offsetMm, p: dir * a.centre, half: a.size / 2 }
		}).sort((x, y) => x.p - y.p)
		if (spans.length === 0) continue
		const target = spans.map((x) => x.p)
		const up = (v: number) => Math.ceil(v * 2 - 1e-9) / 2
		const down = (v: number) => Math.floor(v * 2 + 1e-9) / 2
		// Right to left: inside the far end and clear of the next one; then left to right: inside the near end and clear.
		for (let i = spans.length - 1; i >= 0; i--) {
			const limit = i === spans.length - 1 ? len / 2 - spans[i].half : target[i + 1] - spans[i + 1].half - gap - spans[i].half
			if (target[i] > limit) target[i] = spans[i].p + down(limit - spans[i].p)
		}
		for (let i = 0; i < spans.length; i++) {
			const limit = i === 0 ? -len / 2 + spans[i].half : target[i - 1] + spans[i - 1].half + gap + spans[i].half
			if (target[i] < limit) target[i] = spans[i].p + up(limit - spans[i].p)
		}
		connectors = connectors.map((k) => {
			const i = spans.findIndex((x) => x.ref === k.ref)
			return i < 0 || target[i] === spans[i].p ? k : { ...k, offsetMm: spans[i].offset + (target[i] - spans[i].p) }
		})
	}
	// Across a corner (rover run cc-rover-4: J1 at bottom@42 mm and JM2 at right@10 mm overlapped on a 54x24 board, which
	// packing each edge alone can't see): the smallest single move along its own edge that leaves fewer problems, repeated.
	let now = problems(connectors)
	for (let round = 0; round < 2 * connectors.length && now > 0; round++) {
		let best: { connectors: Connector[]; step: number; left: number } | null = null
		for (const k of connectors) {
			const len = k.edge === "top" || k.edge === "bottom" ? o.widthMm : o.heightMm
			for (let step = 0.5; step <= len && (best === null || step <= best.step); step += 0.5) {
				for (const at of [k.offsetMm - step, k.offsetMm + step]) {
					if (at < 0 || at > len) continue
					const tried = connectors.map((x) => (x.ref === k.ref ? { ...x, offsetMm: at } : x))
					const left = problems(tried)
					if (left < now && (best === null || step < best.step || left < best.left)) best = { connectors: tried, step, left }
				}
			}
		}
		if (best === null) break
		connectors = best.connectors
		now = best.left
	}
	return now < before ? connectors : null
}

// A part the engineer placed on the board page (Part.at) that doesn't fit there: the layout leaves it off rather than
// move it, so this tells the parts owner what is in the way. Placed by the engineer, so the fix is theirs to confirm:
// another spot, or the part in the way moved.
export function pinnedBlocked(c: ContractSnapshot): Violation[] {
	return blockedPins(c).map((b) => {
		const at = c.values.parts?.find((p) => p.ref === b.ref)?.at
		return {
			kind: "part-pinned-blocked" as const,
			message: `${b.ref} was placed at (${at?.xMm}, ${at?.yMm}) mm on the board page, but it doesn't fit there: ${b.why}. The layout leaves it off rather than move it: give it another spot (parts[].at) or drop the spot to let the layout choose`,
			fields: ["parts"] as FieldName[],
			affects: ["parts"] as AgentRole[],
		}
	})
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

// The supply pins a board's generator can't wire, and rails it wires to nothing (the rpi-5 HAT, 15 Nov 2026: its 5V rail
// was declared, but the header's pins are numbered 1-40, so no pin was joined to it and the HAT fed the Pi nothing).
// - part-net-unknown: a Part.nets entry naming a pin the part lacks, or a rail the contract doesn't have.
// - rail-unwired: a rail no two pads share (nothing feeds it, or nothing draws from it).
// - rail-current-copper: a second rail too wide for a track while the one top-layer pour is taken (two layers).
export function supplyWiring(c: ContractSnapshot): Violation[] {
	const { parts = [], rails = [] } = c.values
	// Parts on a supply pin (3V3, VDD, VCC) or a regulator with no 3V3 rail in the contract: the generator wires no supply
	// net at all, and the board's net check (built against the same generator) can't see it. Real run 16 (Eurobot, 16 Nov
	// 2026): rails arrived at revision 23; the board built at 22 had no V3V3 or MCU_EN net, and was taken as current.
	const supplied = parts.filter((p) => p.role !== "connector" && p.pins.some((x) => ["3V3", "VDD", "VCC"].includes(x)))
	if (parts.length && (supplied.length || parts.some((p) => p.role === "ldo")) && !rails.some((r) => r.name === "3V3"))
		return [{ kind: "rail-missing", message: `the contract has no 3V3 rail${rails.length ? ` (its rails: ${rails.map((r) => r.name).join(", ")})` : ""}, but ${supplied.slice(0, 4).map((p) => p.ref).join(", ")}${supplied.length > 4 ? ` and ${supplied.length - 4} more` : ""} ${supplied.length === 1 ? "runs" : "run"} from it: the board generator wires no supply net without it. Add rails: [{name: "3V3", voltageV: 3.3, regulatorMaxMa, loadMa}] (and VBAT for a battery)`, fields: ["rails", "parts"], affects: ["architect"] }]
	if (!parts.length || !rails.length) return []
	const v: Violation[] = [...powerTreeChecks(c)]
	const railNames = new Set(rails.map((r) => r.name))
	for (const p of parts)
		for (const [pin, rail] of Object.entries(p.nets ?? {})) {
			const bad = !p.pins.includes(pin) ? `${p.ref} (${p.mpn}) has no pin "${pin}" (its pins: ${p.pins.join(", ")})` : rail !== "GND" && !railNames.has(rail) ? `rail "${rail}" isn't in the contract's rails (${[...railNames].join(", ")})` : null
			if (bad) v.push({ kind: "part-net-unknown", message: `${p.ref}'s nets put pin ${pin} on ${rail}, but ${bad}: the board generator leaves that pin open`, fields: ["parts", "rails"], affects: ["architect"] })
		}
	const nets = generatedNets(c)
	// A pad on two nets joins them: two supplies shorted (USB 5 V onto a cell), or a rail onto a signal. Whatever put it
	// there, the board must never be built with it.
	const on = new Map<string, string[]>()
	for (const [net, ends] of nets) for (const e of new Set(ends)) on.set(e, [...(on.get(e) ?? []), net])
	for (const [end, ns] of on)
		if (ns.length > 1)
			v.push({ kind: "net-short", message: `${end} is on ${ns.join(" and ")}: that pad joins them, shorting ${ns.join(" to ")}. A pin takes one net: if two sources must feed it, add a power path (two Schottky diodes or a load switch, ORing them) and put the pin on its output; else drop it from one net${Object.entries(c.values.parts?.find((p) => p.ref === end.split(".")[0])?.nets ?? {}).some(([pin]) => pin === end.split(".")[1]) ? ` (the board generator wires ${end} itself: drop it from ${end.split(".")[0]}'s nets)` : ""}`, fields: ["parts", "rails"], affects: ["architect"] })
	for (const r of rails)
		if (!nets.has(netName(r.name)))
			v.push({ kind: "rail-unwired", message: `rail ${r.name} (${r.voltageV} V, ${r.loadMa} mA) reaches no two pads: nothing on the board is wired to it. A part whose supply pin isn't labelled ${r.name === "3V3" ? "3V3/VDD/VCC" : "by the rail"} (a numbered header pin, a power input) names it in its nets, e.g. { "2": "${r.name}" }`, fields: ["parts", "rails"], affects: ["architect"] })
	const poured = new Set(supplyPours(c).map((x) => x.net))
	for (const [net, w] of supplyWidths(c))
		if (w > MAX_TRACK_MM && !poured.has(net))
			v.push({ kind: "rail-current-copper", message: `${net} needs ${w} mm of 1 oz copper for its peak (IPC-2221, 10 °C rise, an estimate), wider than a track reaching a 2.54 mm pin (${MAX_TRACK_MM} mm), and the board's one supply pour is taken by ${[...poured].filter((n) => n !== "GND").join(", ")}: lower its peak or put it on its own board`, fields: ["rails", "parts"], affects: ["architect"] })
	return v
}

// A robot's pack against what its board puts on VBAT (rover-pi, 15 Nov 2026: the main board kept the logger's 1-cell
// TP4054 and the RT9080, rated to 5.5 V, on a 2S pack's 8.4 V). Each part on VBAT whose catalog entry gives maxInV must
// take the pack's full voltage (pack-voltage); a charger must be for the pack's cell count (charger-pack). A part with
// no maxInV in the catalog isn't judged.
export function packVoltage(c: ContractSnapshot): Violation[] {
	const packMpn = c.values.mechanics?.battery?.pack
	const cat = packMpn ? defaultCheckCatalog() : null
	const pack = cat && packMpn ? byMpn(cat.mech.batteries, packMpn) : undefined
	if (!cat || !pack) return []
	const parts = c.values.parts ?? []
	const entry = (mpn: string) => {
		const e = (cat.boardParts as unknown as { mpn: string; maxInV?: number; maxInVSource?: string; cells?: number; floatV?: number; cellsSource?: string; source?: Record<string, { url: string; where: string }> }[]).find((x) => x.mpn.toUpperCase() === mpn.toUpperCase())
		// A part's source is a flat "<field>Source" line or its source map's entry ({url, where}).
		const map = e?.source?.maxInV
		return e && !e.maxInVSource && map ? { ...e, maxInVSource: `${map.url}, ${map.where}` } : e
	}
	const v: Violation[] = []
	const charger = parts.find((p) => p.role === "charger")
	const ch = charger ? entry(charger.mpn) : undefined
	if (charger && ch?.cells !== undefined && ch.cells !== pack.cells)
		v.push({ kind: "charger-pack", message: `${charger.ref} ${charger.mpn} charges ${ch.cells} cell${ch.cells > 1 ? "s" : ""} to ${ch.floatV ?? "?"} V (${ch.cellsSource ?? "catalog"}), but the robot's pack ${pack.mpn} is ${pack.cells}S (${pack.cutoffV}–${pack.fullV} V): it can't charge it and its BAT pin sees ${pack.fullV} V. ${pack.cells > 1 ? "A multi-cell pack charges off the board on a balance charger: drop the charger and its LED, and take the 3.3 V from USB (VBUS), not VBAT" : "Use a charger for this cell count"}`, fields: ["parts"], affects: ["parts"] })
	const onVbat = new Set((generatedNets(c).get("VBAT") ?? []).map((e) => e.split(".")[0]))
	for (const p of parts.filter((x) => onVbat.has(x.ref) && x.role !== "charger")) {
		const e = entry(p.mpn)
		if (e?.maxInV !== undefined && e.maxInV < pack.fullV)
			v.push({ kind: "pack-voltage", message: `${p.ref} ${p.mpn} (${p.role}) is on VBAT and takes at most ${e.maxInV} V (${e.maxInVSource ?? "catalog"}), but the robot's pack ${pack.mpn} reaches ${pack.fullV} V full${p.role === "ldo" ? ": feed it from USB (VBUS) or a 5 V rail, not the pack" : ": pick a part rated for the pack"}`, fields: ["parts"], affects: ["parts"] })
	}
	return v
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

// A pack with no charger on the board (charged off it) must still run the 3V3 rail: through the power tree (circuit.ts
// powerTree), the cell (an ideal diode on a 1S cell; a 5 V step-down and a Schottky on a pack over the LDO's maximum)
// and VBUS (a Schottky) into the LDO. Real run 16 (Eurobot, 16 Nov 2026): the LDO hung on VBUS alone, so on battery the
// 3V3 rail was dead. And the LDO's input on battery, at the pack's nominal voltage less the path's drop at the rail's
// load, must clear its 3.3 V plus dropout.
export function powerTreeChecks(c: ContractSnapshot): Violation[] {
	const parts = c.values.parts ?? []
	const ldo = parts.find((p) => p.role === "ldo")
	if (!ldo || !parts.some((p) => p.role === "battery") || parts.some((p) => p.role === "charger")) return []
	const cat = defaultCheckCatalog()
	type Entry = { mpn: string; role: string; maxInV?: number; dropoutMv?: number; dropoutAtMa?: number; vfV?: number; outV?: number; rOnOhm?: number }
	const list = (cat?.boardParts ?? []) as unknown as Entry[]
	const entry = (mpn: string) => list.find((x) => x.mpn === mpn)
	const byRole = (role: string) => list.find((x) => x.role === role)?.mpn
	const ldoE = entry(ldo.mpn)
	const pack = c.values.mechanics?.battery?.pack && cat ? byMpn(cat.mech.batteries, c.values.mechanics.battery.pack) : undefined
	const vbat = (c.values.rails ?? []).find((r) => r.name === "VBAT")?.voltageV
	const fullV = pack?.fullV ?? vbat, nominalV = pack?.nominalV ?? vbat
	const over = fullV !== undefined && ldoE?.maxInV !== undefined && fullV > ldoE.maxInV
	const tree = powerTree(c)
	const buck = parts.find((p) => p.role === "buck")
	const ideal = parts.some((p) => p.role === "ideal-diode")
	const schottkys = parts.filter((p) => p.role === "diode").length
	if (!tree || (over && !buck)) {
		const need = over
			? [...(!buck ? [`a 5 V step-down (role buck, catalog ${byRole("buck")}, ref U7) for the ${fullV} V pack, over the ${ldo.mpn}'s ${ldoE?.maxInV} V`] : []), ...(schottkys < 2 ? [`${2 - schottkys} Schottky diode${schottkys === 0 ? "s" : ""} (role diode, catalog ${byRole("diode")}, D10 for the step-down's 5 V and D11 for VBUS)`] : [])]
			: [...(!ideal ? [`an ideal diode for the cell (role ideal-diode, catalog ${byRole("ideal-diode")}, ref U8: a Schottky's 0.3–0.6 V would leave the LDO short of input on a 1S cell)`] : []), ...(schottkys < 1 ? [`a Schottky diode for VBUS (role diode, catalog ${byRole("diode")}, ref D10)`] : [])]
		return [{ kind: "rail-battery-source", message: `the pack has no charger on this board, and nothing feeds the 3V3 rail from it: on battery alone ${ldo.ref} (${ldo.mpn}) has no input, so the MCU and everything on 3V3 are off. Add ${need.join(" and ")}: the board generator ORs the ${over ? "step-down's 5 V" : "cell"} and VBUS through them into ${ldo.ref}.VIN (net ${VIN_OR_NET})`, fields: ["parts"], affects: ["parts"] }]
	}
	// Headroom on battery: the path's input (the step-down's output, or the pack at its nominal voltage) less its drop at
	// the 3V3 rail's load, against 3.3 V plus the LDO's dropout scaled to that load (an estimate: dropout grows about
	// linearly with current in the datasheet's figures).
	const loadA = ((c.values.rails ?? []).find((r) => r.name === "3V3")?.loadMa ?? 300) / 1000
	const bE = entry(tree.battery.mpn)
	const drop = tree.battery.role === "ideal-diode" ? loadA * (bE?.rOnOhm ?? 0.1) : (bE?.vfV ?? 0.6)
	const into = tree.buck ? (entry(tree.buck.mpn)?.outV ?? 5) : nominalV
	const dropout = ((ldoE?.dropoutMv ?? 300) / 1000) * (ldoE?.dropoutAtMa ? Math.min(1, (loadA * 1000) / ldoE.dropoutAtMa) : 1)
	const need = 3.3 + dropout
	if (into !== undefined && into - drop < need)
		return [{ kind: "rail-headroom", message: `on battery the LDO gets about ${(into - drop).toFixed(2)} V (${tree.buck ? "the step-down's output" : `the pack's nominal ${into} V`} less ${tree.battery.ref}'s ${drop.toFixed(2)} V at ${Math.round(loadA * 1000)} mA), under the ${need.toFixed(2)} V its 3.3 V needs (output plus about ${Math.round(dropout * 1000)} mV dropout at that load): the 3V3 rail sags. ${tree.battery.role === "ideal-diode" ? "Charge the cell on the board (the charger's output feeds the LDO directly)" : `Use an ideal diode (role ideal-diode, catalog ${byRole("ideal-diode")}) instead of ${tree.battery.ref}`}`, fields: ["parts"], affects: ["parts"] }]
	return []
}
// A part's supply pin by name: what must be on a powered net in any built board.
const SUPPLY_PIN = /^(3V3|VDD|VDDIO|AVDD|DVDD|VCC|VIN|VM|VBAT|V\+)$/
