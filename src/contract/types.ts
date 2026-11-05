// "reviewer" is the LLM brief reviewer and "bench" the hardware bench (agents/bench.ts); neither owns a field. "ml" owns
// the on-device model.
export type AgentRole = "engineer" | "architect" | "parts" | "board" | "enclosure" | "firmware" | "consistency" | "reviewer" | "bench" | "ml"

export type FieldName = "requirements" | "outline" | "connectors" | "rails" | "parts" | "pins" | "behavior" | "model"

export const FIELDS: readonly FieldName[] = ["requirements", "outline", "connectors", "rails", "parts", "pins", "behavior", "model"]

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
}

export interface Outline {
	widthMm: number
	heightMm: number
	thicknessMm: number
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
export const PART_ROLES = ["mcu", "sensor", "microphone", "ldo", "charger", "battery", "usb-c", "led", "charge-led", "resistor", "capacitor", "button", "connector", "other"] as const

// Signals become C macros (PIN_<SIGNAL>) and net names, so they must be UPPER_SNAKE.
export const SIGNAL_PATTERN = /^[A-Z][A-Z0-9_]*$/

export interface Proposal<F extends FieldName = FieldName> {
	field: F
	value: ContractValues[F]
	by: AgentRole
	baseVersion: number
	approvedBy?: AgentRole
}
