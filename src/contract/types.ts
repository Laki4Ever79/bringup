import type { Mechanics, MotionTargets } from "../mechanics/types.ts"
// "reviewer" is the LLM brief reviewer and "bench" the hardware bench (agents/bench.ts); neither owns a field. "ml" owns
// the on-device model, "test" the production test (test pads, pass limits), "enclosure" the case designer's field (case:
// walls, height, added features); the enclosure builder makes the case from it.
export type AgentRole = "engineer" | "architect" | "parts" | "board" | "enclosure" | "firmware" | "consistency" | "reviewer" | "bench" | "ml" | "test" | "connectivity" | "integrator" | "mechanics"

export type FieldName = "requirements" | "outline" | "connectors" | "rails" | "parts" | "pins" | "behavior" | "model" | "test" | "case" | "connectivity" | "links" | "motion" | "mechanics"

export const FIELDS: readonly FieldName[] = ["requirements", "outline", "connectors", "rails", "parts", "pins", "behavior", "model", "test", "case", "connectivity", "links", "motion", "mechanics"]

// The fields every design writes; behavior is optional (the firmware has defaults).
export const CORE_FIELDS: readonly FieldName[] = ["requirements", "outline", "connectors", "rails", "parts", "pins"]

export const OWNERS: Record<FieldName, AgentRole> = {
	requirements: "architect",
	outline: "architect",
	connectors: "architect",
	rails: "architect",
	parts: "parts",
	pins: "architect",
	behavior: "firmware",
	model: "ml",
	test: "test",
	case: "enclosure",
	connectivity: "connectivity",
	// A board in a system of boards (docs/system.md): the system layer writes what this board must expose.
	links: "integrator",
	// A robot (docs/mechanics.md): the brief's motion targets, and the drive, battery and chassis that meet them.
	motion: "architect",
	mechanics: "mechanics",
}

// How the device spends its time: awake for activeMs every periodS seconds, drawing sleepUa in between.
export interface DutyCycle {
	activeMs: number
	periodS: number
	sleepUa: number
}

export interface Requirements {
	summary: string
	peripherals: string[]
	batteryLifeDays: number | null
	// Battery capacity, when the brief does not state it in mAh.
	batteryMah?: number
	dutyCycle?: DutyCycle
	// Days of readings the logger keeps in its flash history; the firmware stores this many (template default 30).
	historyDays?: number
	// A deep-sleeping board wakes when USB is plugged in and stays awake while it is, so a cable alone reflashes it (the
	// board generator adds a VBUS-sense divider). On unless false; off, reflashing needs the recovery pads.
	usbWake?: boolean
	// Who houses the board (engineer, 9 Nov 2026): "case" (the default) Bringup designs and prints one; "none" a bare
	// board (lab use, a dev kit, a test rig); "own" it goes into the engineer's own housing, so Bringup writes the
	// board's mechanical interface (interface.md) for whoever designs it instead of a case.
	enclosure?: EnclosureMode
}

export type EnclosureMode = "case" | "none" | "own"
export const ENCLOSURE_MODES: readonly EnclosureMode[] = ["case", "none", "own"]
export const enclosureMode = (values: { requirements?: Requirements }): EnclosureMode => values.requirements?.enclosure ?? "case"

export interface Outline {
	widthMm: number
	heightMm: number
	thicknessMm: number
	// Why the board is more than 15% over the smallest it can be (contract/space.ts); absent when it isn't.
	sizeReason?: SizeReason
}

// A recorded reason for space over the minimum (docs/space-rules.md): one of the listed kinds, and what it is here.
export interface SizeReason {
	kind: "engineer-size" | "usability" | "standard-fit" | "function" | "assembly-test" | "expansion" | "routing"
	detail: string
}

export interface Connector {
	ref: string
	kind: "usb-c" | "header" | "button"
	edge: "left" | "right" | "top" | "bottom"
	offsetMm: number
	widthMm: number
	heightMm: number
}

export interface Rail {
	name: string
	voltageV: number
	regulatorMaxMa: number
	// Peak load, which the regulator must supply.
	loadMa: number
	// Long-run average including sleep, of this rail's OWN loads: excluding the rails it feeds and the regulator's
	// own quiescent current. So averages never overlap, and the battery current is their sum over every
	// battery-fed rail plus each LDO's quiescent current.
	averageMa?: number
	// "measured" once the bench measured averageMa on the board, at firmware revision measuredRevision.
	averageSource?: "estimated" | "measured"
	measuredRevision?: number
}

export interface Part {
	ref: string
	role: string
	mpn: string
	lcsc: string | null
	footprint: string
	pins: string[]
}

export interface PinAssignment {
	signal: string
	gpio: number
	partRef: string
	partPin: string
}

// What the firmware does, as numbers the template reads from include/behavior.h: the LED blinks every blinkMs,
// and every tiltBlinkMs while the board is tilted more than tiltDeg. No model writes C++.
// The ML model the device runs: what it reads, how big it is, and when it listens. Owned by the ml agent and checked in
// code against the parts (a sensor of its kind, wired), the MCU's flash and RAM left by the firmware, the sensor's
// supported sample rates, and the battery budget (always-on listening keeps the MCU awake).
export interface ModelSpec {
	// What it recognises, e.g. "wake word: hey bringup".
	task: string
	sensor: "microphone" | "motion" | "camera"
	sampleRateHz: number
	// The window one inference sees, and the values per sample (1 for a mic, 6 for an IMU).
	windowMs: number
	channels: number
	// Model weights in flash and the tensor arena in RAM, KB.
	weightsKb: number
	arenaKb: number
	runtime: string
	quantization: "int8" | "float32"
	// "always": the sensor and the MCU stay awake to listen; "on-wake": it listens one window per duty-cycle wake.
	listening: "always" | "on-wake"
	// The training data's sensor path (contract/sensor-path.ts): "recorded" = the dataset was recorded on this path;
	// "needed" = the hardware moved, and data must be recorded on this path with the data-collection firmware.
	data?: ModelData
}

export interface ModelData {
	status: "recorded" | "needed"
	// The contract revision the path was taken at, its hash (stamped on every recording) and the path itself.
	revision: number
	pathHash: string
	path: import("./sensor-path.ts").SensorPath
}

// The production test: which nets get a bottom-side test pad for the fixture's pogo pins, and the current limits the
// factory test passes a board at. Owned by the test agent; checked in code against the pins (every signal probed), the
// generated power nets, and the power budget (a limit below the design's own current fails every good board).
export interface TestSpec {
	// Net names: contract signals (I2C_SDA) and generated power nets (GND, 3V3, VBUS, VBAT).
	points: string[]
	// The board's supply current while awake, and asleep, at or below which it passes.
	awakeMaxMa: number
	sleepMaxUa: number
}

// The case, as the case designer wants it: the enclosure builder (py/enclosure.py) makes the shell, the cutouts, the
// standoffs and the lid from the board, and these settings and features on top. Optional: without it the case has 2 mm
// walls, a 14 mm body and no features. The case's outer size is the board's outline plus clearance and walls on each
// side, so a case that must be smaller means a smaller board: a change to the architect's outline, which also waits
// for the engineer's confirmation (contract/case.ts).
export interface CaseSpec {
	// Wall and floor thickness.
	wallMm: number
	// The body's outer height, floor underside to the lid's seat (the lid's plate adds its own 2 mm).
	heightMm: number
	features: CaseFeature[]
	// Why the body is more than 15% taller than its contents need (contract/space.ts).
	sizeReason?: SizeReason
}

export type CaseFeature =
	// Two flat tabs with a screw hole, flush with the floor, on opposite sides: screws the case to a wall.
	| { id: string; kind: "wall-mount"; sides: "left-right" | "top-bottom" }
	// A flat tab with a hole for a lanyard or a key ring, at one corner on the left or right wall.
	| { id: string; kind: "lanyard"; corner: "top-left" | "top-right" | "bottom-left" | "bottom-right" }
	// Lettering engraved into the lid's top, centred.
	| { id: string; kind: "text"; text: string }
	// A round hole through a wall (a cable gland, a cable, a light pipe), centred offsetMm along the edge in the
	// connectors' frame, halfway up the wall's free height.
	| { id: string; kind: "hole"; edge: "left" | "right" | "top" | "bottom"; offsetMm: number; diameterMm: number }

// How the product reaches its owner: the radio, how the readings leave the device, and whether its firmware can be
// updated in the field. Owned by the connectivity engineer; checked in code against the power budget (the radio's
// transmit peak and, for Wi-Fi, each connection's energy) and the flash (an update needs a second firmware slot).
// Optional: without it the device is what it always was, Bluetooth LE with its GATT service, no updates.
export interface Connectivity {
	radio: "ble" | "wifi"
	// "gatt": a phone connects and reads the history (BLE). "bthome": each reading is broadcast in BTHome v2 advertising,
	// which Home Assistant picks up with no app (BLE). "mqtt": readings are published to an MQTT broker with Home
	// Assistant discovery (Wi-Fi).
	report: ("gatt" | "bthome" | "mqtt")[]
	// Wi-Fi only: the device connects once per uploadPeriodS and uploads what it stored since, a whole multiple of the
	// duty cycle's period. Connecting costs seconds of radio time, so every reading would cost the battery far more.
	uploadPeriodS?: number
	// "ota": the firmware can be updated over Wi-Fi, so the flash keeps two firmware slots. "none": one bigger slot.
	updates: "none" | "ota"
}

// One end of a link between two boards in a system (docs/system.md), written by the system's integrator. The
// connector is a 4-pin JST SH: 1 GND, 2 VCC, 3 IO1, 4 IO2.
export type LinkPin = "IO1" | "IO2"
export interface BoardLink {
	id: string // the system's link id, e.g. "L1"; a UART link's signals are <id>_TX and <id>_RX
	kind: "uart" | "i2c"
	peer: string // the board at the other end
	connector: string // this board's ref for the link connector, e.g. "J3"
	edge?: Connector["edge"] // where the cable should leave, if the system cares
	// uart: the speed, and which IO pin carries this board's TX (the other carries RX)
	baud?: number
	txOn?: LinkPin
	// i2c (IO1 SDA, IO2 SCL): this board's role on the bus, its address as a target, whether it fits the bus pull-ups
	// peerAddress: the controller sends to it (the target's own address).
	i2c?: { role: "controller" | "target"; address?: number; peerAddress?: number; pullups: boolean; khz: number }
	// VCC (pin 2): "none" unconnected; "out" this board's 3V3 powers the peer; "in" this board runs from the peer's 3V3
	supply: "none" | "out" | "in"
	// What crosses the link, the same definition on both boards (the system checks the hash)
	messages?: LinkMessage[]
}
export interface LinkMessage {
	name: string
	dir: "send" | "receive"
	fields: { name: string; type: "u8" | "u16" | "i16" | "u32" | "f32" }[]
	hash: string
}

export interface Behavior {
	blinkMs: number
	tiltBlinkMs: number
	tiltDeg: number
}

export type ContractValues = {
	requirements: Requirements
	outline: Outline
	connectors: Connector[]
	rails: Rail[]
	parts: Part[]
	pins: PinAssignment[]
	behavior: Behavior
	model: ModelSpec
	test: TestSpec
	case: CaseSpec
	connectivity: Connectivity
	links: BoardLink[]
	motion: MotionTargets
	mechanics: Mechanics
}

export interface ContractSnapshot {
	revision: number
	values: Partial<ContractValues>
	versions: Record<FieldName, number>
}

export type ProposalResult =
	| { status: "applied"; version: number; revision: number }
	| { status: "stale"; current: number }
	| { status: "not-owner"; owner: AgentRole }
	| { status: "invalid"; reason: string }
	| { status: "unchanged"; version: number }

// Part roles the board codegen, catalog and checks understand.
export const PART_ROLES = ["mcu", "sensor", "microphone", "ldo", "charger", "battery", "usb-c", "led", "charge-led", "resistor", "capacitor", "button", "connector", "motor-driver", "other"] as const

// Signals become C macros (PIN_<SIGNAL>) and net names, so they must be UPPER_SNAKE.
export const SIGNAL_PATTERN = /^[A-Z][A-Z0-9_]*$/

export interface Proposal<F extends FieldName = FieldName> {
	field: F
	value: ContractValues[F]
	by: AgentRole
	baseVersion: number
	approvedBy?: AgentRole
}
