import { pathHash, sensorPath } from "../contract/sensor-path.ts"
import { LINK_CONNECTOR } from "../contract/links.ts"
import { defaultTestSpec, expectedCurrents, probeableNets } from "../contract/testkit.ts"
import { testPoints } from "../codegen/circuit.ts"
import { FunctionCallOutputItem, ModelMessageItem, UserMessageItem, type ContextItem } from "@mozaik-ai/core"
import type { CaseSpec, ContractSnapshot, ContractValues, EnclosureMode, FieldName } from "../contract/types.ts"
import { boardWidthFor, caseChecks, caseOf, LID, minCaseHeight } from "../contract/case.ts"
import { compactOutline, ROUTING_FAILURE, SLACK_LIMIT } from "../contract/space.ts"
import { state } from "../runtime.ts"
import { toolCall, type Script } from "./scripted-runner.ts"
import { DEFAULT_BEHAVIOR } from "../codegen/firmware.ts"

// The logger design the mock agents produce: ESP32-C3, SHT40 over I2C, USB-C power, LDO, LED.
export const LOGGER_DESIGN: Omit<ContractValues, "parts" | "behavior" | "model" | "test" | "case" | "connectivity" | "links" | "motion" | "mechanics"> & { parts: ContractValues["parts"] } = {
	// ESP32-C3 deep sleep about 10 µA; every 5 min it wakes for a 30 ms reading and a 300 ms BLE advertising burst at
	// about 25 mA. Average: 25 mA × 330 ms / 300 s + 10 µA = 37.5 µA, before the LDO's own quiescent current.
	requirements: {
		summary: "BLE temperature and humidity logger",
		peripherals: ["i2c-sensor", "usb-c", "status-led"],
		batteryLifeDays: 180,
		dutyCycle: { activeMs: 330, periodS: 300, sleepUa: 10 },
	},
	// The brief asks for this size (space rules: the engineer's size is the reason the board is over the minimum).
	outline: { widthMm: 50, heightMm: 30, thicknessMm: 1.6, sizeReason: { kind: "engineer-size", detail: "the brief asks for about 50 × 30 mm" } },
	connectors: [{ ref: "J1", kind: "usb-c", edge: "left", offsetMm: 15, widthMm: 9, heightMm: 3.5 }],
	// loadMa: the module transmitting Bluetooth LE at 0 dBm peaks at 170 mA (ESP32-C3-MINI-1 datasheet v2.2), plus the rest.
	rails: [{ name: "3V3", voltageV: 3.3, regulatorMaxMa: 600, loadMa: 200, averageMa: 0.0375 }],
	pins: [
		{ signal: "I2C_SDA", gpio: 8, partRef: "U2", partPin: "SDA" },
		{ signal: "I2C_SCL", gpio: 9, partRef: "U2", partPin: "SCL" },
	],
	parts: [
		{ ref: "U1", role: "mcu", mpn: "ESP32-C3-MINI-1", lcsc: "C2838502", footprint: "esp32_c3_mini_1", pins: ["GPIO0", "GPIO1", "GPIO2", "GPIO3", "GPIO4", "GPIO5", "GPIO6", "GPIO7", "GPIO8", "GPIO9", "GPIO10", "GPIO18", "GPIO19", "EN", "3V3", "GND"] },
		{ ref: "U2", role: "sensor", mpn: "SHT40-AD1B-R2", lcsc: "C2909890", footprint: "dfn4", pins: ["SDA", "SCL", "VDD", "VSS"] },
		{ ref: "U3", role: "ldo", mpn: "RT9080-33GJ5", lcsc: "C841192", footprint: "sot23_5", pins: ["VIN", "GND", "EN", "NC", "VOUT"] },
		{ ref: "U4", role: "charger", mpn: "TP4054-42-SOT25R", lcsc: "C32574", footprint: "sot23_5", pins: ["CHRG", "GND", "BAT", "VCC", "PROG"] },
		{ ref: "J1", role: "usb-c", mpn: "TYPE-C-31-M-12", lcsc: "C165948", footprint: "usbcmidmount", pins: ["VBUS", "GND", "CC1", "CC2", "DP", "DN"] },
		{ ref: "J2", role: "battery", mpn: "S2B-PH-K-S(LF)(SN)", lcsc: "C173752", footprint: "jst2_ph", pins: ["VBAT", "GND"] },
		{ ref: "D1", role: "led", mpn: "KT-0603R", lcsc: "C2286", footprint: "0603", pins: ["A", "K"] },
		{ ref: "D2", role: "charge-led", mpn: "KT-0603R", lcsc: "C2286", footprint: "0603", pins: ["A", "K"] },
		// Support passives. Codegen claims them by LCSC number in job order: LED (R1), charge LED (R7), CC1, CC2, PROG,
		// I2C pull-ups, bypass caps, the USB-sense divider (R8 68k, R9 100k).
		{ ref: "R1", role: "resistor", mpn: "0402WGF1001TCE", lcsc: "C11702", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "R2", role: "resistor", mpn: "0402WGF5101TCE", lcsc: "C25905", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "R3", role: "resistor", mpn: "0402WGF5101TCE", lcsc: "C25905", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "R4", role: "resistor", mpn: "0402WGF4701TCE", lcsc: "C25900", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "R5", role: "resistor", mpn: "0402WGF1002TCE", lcsc: "C25744", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "R6", role: "resistor", mpn: "0402WGF1002TCE", lcsc: "C25744", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "R7", role: "resistor", mpn: "0402WGF1001TCE", lcsc: "C11702", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "R8", role: "resistor", mpn: "0402WGF6802TCE", lcsc: "C36871", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "R9", role: "resistor", mpn: "0402WGF1003TCE", lcsc: "C25741", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "C1", role: "capacitor", mpn: "CL05A105KA5NQNC", lcsc: "C52923", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "C2", role: "capacitor", mpn: "CL05A105KA5NQNC", lcsc: "C52923", footprint: "0402", pins: ["pin1", "pin2"] },
		{ ref: "C3", role: "capacitor", mpn: "CL10A106KP8NNNC", lcsc: "C19702", footprint: "0603", pins: ["pin1", "pin2"] },
	],
}

// The second scripted design, for briefs/beacon.md: the logger's board without the sensor (and its I2C pull-ups), plus
// a button on the top edge that wakes it. ESP32-C3 deep sleep about 10 µA; every 60 s it wakes for a 300 ms BLE
// advertising burst (plus the 30 ms wake) at about 25 mA: 25 mA × 330 ms / 60 s + 10 µA = 147.5 µA. With the
// RT9080's 2 µA, one phone connection a day (about 30 µA) and the charger's 6 µA, a 500 mAh cell lasts about 112 days,
// past the brief's 3 months. (With the AP2112K's 55 µA it fell short once phone use and the charger were counted.)
export const BEACON_DESIGN: typeof LOGGER_DESIGN = {
	requirements: {
		summary: "BLE beacon with a wake button",
		peripherals: ["usb-c", "status-led", "button"],
		batteryLifeDays: 90,
		dutyCycle: { activeMs: 330, periodS: 60, sleepUa: 10 },
	},
	outline: LOGGER_DESIGN.outline,
	connectors: [...LOGGER_DESIGN.connectors, { ref: "SW1", kind: "button", edge: "top", offsetMm: 25, widthMm: 4, heightMm: 3 }],
	rails: [{ ...LOGGER_DESIGN.rails[0], averageMa: 0.1475 }],
	pins: [{ signal: "BUTTON", gpio: 3, partRef: "SW1", partPin: "A" }],
	parts: [
		...LOGGER_DESIGN.parts.filter((p) => !["U2", "R5", "R6"].includes(p.ref)),
		{ ref: "SW1", role: "button", mpn: "TS-1187A-B-A-B", lcsc: "C318884", footprint: "pushbutton", pins: ["A", "B"] },
	],
}

// "add a temperature/humidity sensor": the logger's SHT40 with its two I2C pull-ups, on the logger's I2C pins.
export const ADD_SENSOR_REQUEST = /add .*(temp|humid|sensor)/i
const SENSOR_PARTS = LOGGER_DESIGN.parts.filter((p) => ["U2", "R5", "R6"].includes(p.ref))
const SENSOR_PINS = LOGGER_DESIGN.pins.filter((p) => p.partRef === "U2")

// Which scripted design a brief gets: the beacon for a brief that says so, the logger for anything else.
export const scriptedDesignFor = (brief: string) => (/\bbeacon\b/i.test(brief) ? BEACON_DESIGN : LOGGER_DESIGN)

// The beacon's parts for its current requirements: with a sensor once the requirements ask for one.
function beaconParts(): ContractValues["parts"] {
	const sensing = state().contract.get("requirements")?.peripherals.includes("i2c-sensor")
	return sensing ? [...BEACON_DESIGN.parts, ...SENSOR_PARTS] : BEACON_DESIGN.parts
}
const isBeacon = () => (state().contract.get("requirements")?.peripherals ?? []).includes("button")

const STATUS_LED = { signal: "STATUS_LED", gpio: 10, partRef: "D1", partPin: "A" }

// "add a wake word": the ml agent writes a keyword-spotting model (sizes planned from MLPerf Tiny's DS-CNN keyword
// spotter, int8), always listening; the checks then wake parts (no microphone), the architect (its I2S lines, and the
// battery target always-on listening can't meet). Each step is the owner's own field.
export const DATA_RECORDED_REQUEST = /\bdata (?:is |was |has been )?recorded|recorded the (?:training )?data/i
// "add a production test" / "we need a test fixture": the test agent's request.
export const TEST_REQUEST = /(production|factory|end.of.line) test|test (fixture|jig|kit|pads?)|bed.of.nails|pogo/i

// The test agent's fix for its own violations: probe every net the design has (dropping ones it lost, adding new ones,
// in the design's order), keep limits at least the design's own currents with margin, and drop what can't be placed.
function followDesign(t: ContractValues["test"]): ContractValues["test"] {
	const s = state().contract.snapshot()
	const { signals, power } = probeableNets(s)
	const wanted = [...signals, ...power.filter((n) => n !== "VBUS" || t.points.includes("VBUS"))]
	const { awakeMa, sleepUa } = expectedCurrents(s)
	const next = {
		points: [...t.points.filter((p) => wanted.includes(p)), ...wanted.filter((p) => !t.points.includes(p))],
		awakeMaxMa: awakeMa !== null && t.awakeMaxMa < awakeMa ? Math.ceil(awakeMa * 1.2) : t.awakeMaxMa,
		sleepMaxUa: sleepUa !== null && t.sleepMaxUa < sleepUa ? Math.ceil(sleepUa * 1.5) : t.sleepMaxUa,
	}
	const { unplaced } = testPoints({ ...s, values: { ...s.values, test: next } })
	return { ...next, points: next.points.filter((p) => !unplaced.includes(p)) }
}

// The model's data on the sensor path the contract describes now, or null when there is none to record on.
function dataOn(status: "recorded" | "needed") {
	const s = state().contract.snapshot()
	const path = sensorPath(s)
	return path ? { status, revision: s.revision, pathHash: pathHash(path), path } : null
}
// A request about the case: the case designer's. Its size, walls, height, lid, lettering, tabs, loops and holes.
// Who houses the board, from a brief or a request: "none" for a bare board, "own" for the engineer's own housing,
// "case" when it asks for ours; null when it doesn't say.
export function enclosureFromText(t: string): EnclosureMode | null {
	if (/bare board|no (case|enclosure|housing)\b|without (a |any )?(case|enclosure)|drop the case|remove the case/i.test(t)) return "none"
	if (/\b(our|my|their) own (housing|enclosure|case)\b|existing (housing|enclosure|product)/i.test(t)) return "own"
	if (/\bcase\b/i.test(t)) return "case"
	return null
}
// A request that changes whether there is a case at all: the architect's requirements.enclosure, not the case field.
export const ENCLOSURE_MODE_REQUEST = /bare board|no (case|enclosure)\b|without (a |any )?(case|enclosure)|drop the case|remove the case|own (housing|enclosure)|existing (housing|enclosure|product)|(add|bring back|we want) (a|the) case/i
// The scripted architect's answer to a board's links (docs/system.md): the link connector on an edge (the link's own, or
// the first with no connector, top first), then a UART link's TX and RX on free GPIOs. One field per turn.
const FREE_GPIOS = [4, 5, 6, 7, 3, 1, 0] // not the strapping pins (2, 8, 9) nor USB (18, 19)
export function linkProposal(s: ContractSnapshot): { field: "connectors" | "pins"; value: unknown; reason: string } | null {
	const { connectors = [], pins = [], parts = [] } = s.values
	for (const l of s.values.links ?? []) {
		if (!parts.some((p) => p.ref === l.connector)) continue // the part selector adds it first
		if (!connectors.some((k) => k.ref === l.connector)) {
			const o = s.values.outline
			const edge = l.edge ?? (["top", "bottom", "right", "left"] as const).find((e) => !connectors.some((k) => k.edge === e)) ?? "top"
			const along = o ? (edge === "left" || edge === "right" ? o.heightMm : o.widthMm) / 2 : 10
			return { field: "connectors", value: [...connectors, { ref: l.connector, kind: "header", edge, offsetMm: along, widthMm: 5.8, heightMm: 3 }], reason: `${l.id}'s connector on the ${edge} edge, so the cable leaves there` }
		}
		// An I2C link on a board with no bus yet: I2C_SDA and I2C_SCL straight to the connector.
		if (l.kind === "i2c" && !pins.some((p) => p.signal === "I2C_SDA")) {
			const used = new Set(pins.map((p) => p.gpio))
			const free = FREE_GPIOS.filter((g) => !used.has(g))
			if (free.length < 2) return null
			return { field: "pins", value: [...pins, { signal: "I2C_SDA", gpio: free[0], partRef: l.connector, partPin: "IO1" }, { signal: "I2C_SCL", gpio: free[1], partRef: l.connector, partPin: "IO2" }], reason: `${l.id}'s I2C bus: SDA and SCL to the connector` }
		}
		if (l.kind === "uart" && l.txOn) {
			const want = [
				{ signal: `${l.id}_TX`, partPin: l.txOn },
				{ signal: `${l.id}_RX`, partPin: l.txOn === "IO1" ? "IO2" : "IO1" },
			]
			if (want.every((w) => pins.some((p) => p.signal === w.signal && p.partRef === l.connector && p.partPin === w.partPin))) continue
			const kept = pins.filter((p) => !want.some((w) => w.signal === p.signal))
			const used = new Set(kept.map((p) => p.gpio))
			const free = FREE_GPIOS.filter((g) => !used.has(g))
			if (free.length < 2) return null
			return { field: "pins", value: [...kept, ...want.map((w, i) => ({ signal: w.signal, gpio: free[i], partRef: l.connector, partPin: w.partPin }))], reason: `${l.id}'s UART: TX and RX on the connector pins the system gives` }
		}
	}
	return null
}

export const CASE_REQUEST = /\b(case|enclosure|housing|lid)\b|wall.?mount|lanyard|key ?ring|cable gland/i
const EDGE_ORDER = ["right", "top", "bottom", "left"] as const

// The case's outer width a request asks for ("make the case 45 mm wide"), if any.
export function requestedCaseWidth(request: string): number | null {
	const m = /(\d+(?:\.\d+)?)\s*mm wide/i.exec(request)
	return m && CASE_REQUEST.test(request) ? Number(m[1]) : null
}

const clean = (c: CaseSpec, s: ContractSnapshot, id: string) => !caseChecks({ ...s, values: { ...s.values, case: c } }).some((v) => v.message.includes(` ${id} `) || v.message.startsWith(`${id} `))

// Puts a hole where it fits: its own edge first, from the middle outwards in 1 mm steps, then the other edges.
type Edge = (typeof EDGE_ORDER)[number]
function placeHole(c: CaseSpec, s: ContractSnapshot, id: string, edges: readonly Edge[]): CaseSpec {
	const outline = s.values.outline!
	for (const edge of edges) {
		const len = edge === "left" || edge === "right" ? outline.heightMm : outline.widthMm
		for (let k = 0; k <= len; k++) {
			const offsetMm = Math.round(len / 2 + (k % 2 === 0 ? k / 2 : -(k + 1) / 2))
			const next = { ...c, features: c.features.map((f) => (f.id === id && f.kind === "hole" ? { ...f, edge, offsetMm } : f)) }
			if (clean(next, s, id)) return next
		}
	}
	return c
}

// The scripted case designer's reading of a request: the new case field. Deterministic, like every mock script.
export function caseFromRequest(request: string, s: ContractSnapshot): CaseSpec {
	let c: CaseSpec = structuredClone(caseOf(s))
	const connectorEdges = new Set((s.values.connectors ?? []).map((k) => k.edge))
	const walls = /(\d+(?:\.\d+)?)\s*mm(?: thick)? walls?/i.exec(request)
	if (walls) c.wallMm = Number(walls[1])
	else if (/(thicker|sturdier|stronger) walls?/i.test(request)) c.wallMm = Math.min(4, c.wallMm + 1)
	else if (/thinner walls?/i.test(request)) c.wallMm = Math.max(1.2, c.wallMm - 0.5)
	const tall = /(\d+(?:\.\d+)?)\s*mm (?:tall|high)/i.exec(request)
	if (tall) c.heightMm = Number(tall[1])
	else if (/\b(taller|higher)\b/i.test(request)) c.heightMm += 4
	// The engineer's own height is the reason the body is that tall (space rules).
	if (tall || /\b(taller|higher)\b/i.test(request)) c.sizeReason = { kind: "engineer-size", detail: `the engineer asked: ${request}` }
	else if (/\b(lower|slimmer|flatter|thinner case)\b/i.test(request)) c.heightMm = Math.max(minCaseHeight(s, c), c.heightMm - 3)
	const add = (f: CaseSpec["features"][number]) => (c = { ...c, features: [...c.features.filter((x) => x.id !== f.id), f] })
	if (/wall.?mount|mounting (tabs?|ears?)|screw it to a wall/i.test(request))
		add({ id: "wall-mount", kind: "wall-mount", sides: connectorEdges.has("left") || connectorEdges.has("right") ? "top-bottom" : "left-right" })
	if (/lanyard|key ?ring|strap/i.test(request)) {
		const corner = (["top-right", "bottom-right", "top-left", "bottom-left"] as const).find((k) => !connectorEdges.has(k.endsWith("left") ? "left" : "right")) ?? "top-right"
		add({ id: "lanyard", kind: "lanyard", corner })
	}
	const quoted = /["“']([^"”']{1,24})["”']/.exec(request)?.[1]?.replace(/[^A-Za-z0-9 .,:!?&+#/-]/g, "").trim()
	if (quoted && /engrave|text|label|logo|write|name|letter/i.test(request)) add({ id: "label", kind: "text", text: quoted })
	if (/cable gland|\bhole\b/i.test(request)) {
		// An M12 cable gland (the common size for a 3-6.5 mm cable) wants a 12.2 mm hole: a typical figure, check the
		// gland's datasheet. A plain cable hole: 6 mm.
		const given = /(\d+(?:\.\d+)?)\s*mm (?:hole|gland|cable gland)/i.exec(request)
		const diameterMm = given ? Number(given[1]) : /gland/i.test(request) ? 12.2 : 6
		const asked = /on the (left|right|top|bottom)/i.exec(request)?.[1]?.toLowerCase() as Edge | undefined
		const edge = asked ?? EDGE_ORDER.find((e) => !connectorEdges.has(e)) ?? "right"
		const id = `hole-${c.features.filter((f) => f.kind === "hole").length + 1}`
		// A hole this big needs this much wall between the floor and the lid's lip.
		c.heightMm = Math.max(c.heightMm, Math.ceil(diameterMm + 1 + LID.lipMm + c.wallMm))
		add({ id, kind: "hole", edge, offsetMm: 0, diameterMm })
		c = placeHole(c, s, id, asked ? [asked] : [edge, ...EDGE_ORDER.filter((e) => e !== edge)])
	}
	return c
}

// The scripted case designer's fix for its own violations: a body tall enough, every hole moved to where it fits.
function caseFollows(s: ContractSnapshot): CaseSpec {
	let c: CaseSpec = structuredClone(caseOf(s))
	const need = minCaseHeight(s, c)
	// Compact by default: a body taller than its contents need, with no reason, comes down to what they need.
	c.heightMm = !c.sizeReason && c.heightMm > need * (1 + SLACK_LIMIT) ? Math.ceil(need) : Math.max(c.heightMm, need)
	for (const f of c.features) if (f.kind === "hole" && !clean(c, s, f.id)) c = placeHole(c, s, f.id, [f.edge, ...EDGE_ORDER.filter((e) => e !== f.edge)])
	return c
}

// A request about how the device connects: the connectivity engineer's.
export const CONNECTIVITY_REQUEST = /home assistant|bthome|wi-?fi|mqtt|bluetooth|\bble\b|\bota\b|firmware updates?|over.the.air|phone app/i

// The scripted connectivity engineer's reading of a request. Home Assistant without Wi-Fi: BTHome over Bluetooth LE
// (no app, no hub beyond Home Assistant's own Bluetooth). Wi-Fi or MQTT: MQTT with Home Assistant discovery, hourly
// unless the request says how often. Updates need Wi-Fi.
export function connectivityFromRequest(request: string, current: ContractValues["connectivity"] | undefined): ContractValues["connectivity"] {
	const wantsUpdates = /\bota\b|firmware updates?|over.the.air|update(?:s|d)? in the field/i.test(request)
	if (/wi-?fi|mqtt/i.test(request) || wantsUpdates) {
		const every = /every (\d+) ?(min|minute|minutes|h|hour|hours)\b/i.exec(request)
		const uploadPeriodS = every ? Number(every[1]) * (/^h/i.test(every[2]) ? 3600 : 60) : current?.uploadPeriodS ?? 3600
		return { radio: "wifi", report: ["mqtt"], uploadPeriodS, updates: wantsUpdates ? "ota" : current?.updates === "ota" ? "ota" : "none" }
	}
	const report = new Set<"gatt" | "bthome">(current?.radio === "ble" ? (current.report as ("gatt" | "bthome")[]) : ["gatt"])
	if (/home assistant|bthome/i.test(request)) report.add("bthome")
	return { radio: "ble", report: [...report], updates: "none" }
}

export const WAKE_WORD_REQUEST = /wake ?word|keyword|voice command|listen for/i
export const WAKE_WORD_MODEL = { task: "wake word", sensor: "microphone", sampleRateHz: 16000, windowMs: 1000, channels: 1, weightsKb: 53, arenaKb: 23, runtime: "tflite-micro", quantization: "int8", listening: "always" } as const
export const MIC_PART = { ref: "U5", role: "microphone", mpn: "ICS-43434", lcsc: "C5656610", footprint: "ics43434", pins: ["WS", "LR", "GND", "SCK", "VDD", "SD"] }
export const MIC_PINS = [
	{ signal: "MIC_SCK", gpio: 4, partRef: "U5", partPin: "SCK" },
	{ signal: "MIC_WS", gpio: 5, partRef: "U5", partPin: "WS" },
	{ signal: "MIC_SD", gpio: 6, partRef: "U5", partPin: "SD" },
]
const violationKinds = (instruction: string) => new Set([...instruction.matchAll(/^- ([\w-]+):/gm)].map((m) => m[1]))

function text(item: ContextItem | undefined): string {
	if (item instanceof UserMessageItem) return item.content.text
	if (item instanceof FunctionCallOutputItem) return item.output.text
	return ""
}

// Tool outputs since the last instruction to this turn.
function stepsTaken(items: ContextItem[]): number {
	const start = items.findLastIndex((i) => i instanceof UserMessageItem)
	return items.slice(start + 1).filter((i) => i instanceof FunctionCallOutputItem).length
}

const say = (t: string) => [ModelMessageItem.rehydrate({ text: t })]

function propose(field: FieldName, value: unknown, reason: string) {
	return [toolCall("propose_contract_change", { field, value, baseVersion: state().contract.version(field), reason })]
}

const ARCHITECT_FIELDS = ["requirements", "outline", "connectors", "rails", "pins"] as const satisfies FieldName[]

// Deterministic stand-ins for each role's model, so a full run needs no API key.
export function mockScripts(): Record<string, Script> {
	// The outline the scripted architect shrank from, until it has moved the connectors to match (space rules).
	let shrinkFrom: { widthMm: number; heightMm: number } | null = null
	// How many times the scripted architect has widened the board after a failed DRC in this run.
	let drcGrows = 0
	return {
		"mock-architect": (items) => {
			const instruction = text(items.findLast((i) => i instanceof UserMessageItem))
			const step = stepsTaken(items)
			if (instruction.startsWith("Consistency violations for you")) {
				const kinds = violationKinds(instruction)
				const pins = state().contract.get("pins") ?? []
				const requirements = state().contract.get("requirements")
				const model = state().contract.get("model")
				if (step === 0 && (kinds.has("link-connector-missing") || kinds.has("link-unwired"))) {
					const next = linkProposal(state().contract.snapshot())
					if (next) return propose(next.field, next.value as never, next.reason)
				}
				if (step === 0 && kinds.has("model-sensor-unwired") && !pins.some((p) => p.signal === "MIC_SD")) return propose("pins", [...pins, ...MIC_PINS], "the microphone's I2S SCK, WS and SD on GPIO4-6, free of the I2C bus and the LED")
				// Always-on listening keeps the MCU awake: no cell this size meets the target, so the design runs from USB.
				if (step === 0 && kinds.has("battery-short") && model?.listening === "always" && requirements && requirements.batteryLifeDays !== null)
					return propose(
						"requirements",
						{ ...requirements, summary: `${requirements.summary}, listening for a wake word (always on, so powered from USB)`, peripherals: [...new Set([...requirements.peripherals, "microphone"])], batteryLifeDays: null },
						"always-on listening keeps the MCU awake at about 28 mA: the battery lasts under a day, so the target becomes USB power",
					)
				// No reason for the board's slack: shrink it to the smallest it can be, connectors first when the height changes.
				// The rail's peak below the radio's transmit peak: raise it to that, with a fifth on top for the rest.
				const under = /^- rail-underrated: rail (\S+) is sized for a [\d.]+ mA peak, below (\d+) mA/m.exec(instruction)
				const railsNow = state().contract.get("rails")
				if (step === 0 && under && railsNow) {
					const need = Math.ceil((Number(under[2]) * 1.2) / 10) * 10
					return propose("rails", railsNow.map((r) => (r.name === under[1] ? { ...r, loadMa: Math.max(r.loadMa, need) } : r)), `the radio's transmit peak is ${under[2]} mA: the rail's peak covers it, with a fifth on top for the rest of the board`)
				}
				// KiCad's DRC failed on the board at this size: room for the router, 2 mm wider at a time, with the failed
				// build as the reason (space rules: a measured routing failure). Five tries, then it stops and says so.
				const drcLine = /^- drc-errors: (.*)$/m.exec(instruction)?.[1]
				const now = state().contract.get("outline")
				if (step === 0 && drcLine && now) {
					if (drcGrows >= 5) return say("can't route it")
					drcGrows++
					const build = /^(the [\d.]+×[\d.]+ mm board \(rev \d+\))/.exec(drcLine)?.[1] ?? "the last build"
					// The first error runs to the sentence that follows it (it has decimals of its own: "actual 0.1412 mm").
					const first = /first: (.*?)\. Give the router room/.exec(drcLine)?.[1]
					return propose("outline", { ...now, widthMm: now.widthMm + 2, sizeReason: { kind: "routing", detail: `${build} failed KiCad DRC${first ? `: ${first}` : ""}` } }, `2 mm wider so the router has room: ${build} failed DRC`)
				}
				// The outline first, then the connectors scaled from the old outline to the new one: their place along each
				// edge stays the same. (Moving the connectors first changed the minimum under the next turn.)
				const o = state().contract.get("outline")
				if (step === 1 && shrinkFrom && o) {
					const from = shrinkFrom
					shrinkFrom = null
					const connectors = state().contract.get("connectors") ?? []
					const scaled = connectors.map((c) => {
						const [a, b] = c.edge === "left" || c.edge === "right" ? [from.heightMm, o.heightMm] : [from.widthMm, o.widthMm]
						return { ...c, offsetMm: Math.round(((c.offsetMm * b) / a) * 2) / 2 }
					})
					if (JSON.stringify(scaled) !== JSON.stringify(connectors)) return propose("connectors", scaled, `the connectors keep their place along the edges of the ${o.widthMm}×${o.heightMm} mm board`)
				}
				const target = step === 0 && kinds.has("space-slack") && o && !o.sizeReason ? compactOutline(state().contract.snapshot()) : null
				if (target && o && (o.widthMm * o.heightMm) / (target.widthMm * target.heightMm) - 1 > SLACK_LIMIT) {
					shrinkFrom = { widthMm: o.widthMm, heightMm: o.heightMm }
					return propose("outline", { ...o, widthMm: target.widthMm, heightMm: target.heightMm }, `compact by default: the parts place on ${target.widthMm}×${target.heightMm} mm, and nothing asks for more`)
				}
				return say("violations handled")
			}
			if (instruction.startsWith("Change request from the engineer:")) {
				// A saved pins.h (runner/file-sync.ts): "edited pins.h: I2C_SDA GPIO8 → GPIO4; …".
				const moves = [...instruction.matchAll(/(\w+) GPIO(\d+) → GPIO(\d+)/g)]
				const current = state().contract.get("pins")
				if (moves.length > 0 && current) {
					if (step > 0) return say("pins updated")
					const value = current.map((p) => {
						const m = moves.find((x) => x[1] === p.signal)
						return m ? { ...p, gpio: Number(m[3]) } : p
					})
					return propose("pins", value, `engineer edited pins.h: ${moves.map((m) => m[0]).join("; ")}`)
				}
				// A saved board.kicad_pcb: "edited board.kicad_pcb: outline 50×30 → 45×30 mm; J1 left@15 → left@12 mm".
				const resized = /outline [\d.]+×[\d.]+ → ([\d.]+)×([\d.]+) mm/.exec(instruction)
				const shifts = [...instruction.matchAll(/(\w+) (left|right|top|bottom)@[\d.]+ → (left|right|top|bottom)@([\d.]+) mm/g)]
				if (instruction.includes("edited board.kicad_pcb:") && (resized || shifts.length > 0)) {
					const outlineNow = state().contract.get("outline")
					const connectorsNow = state().contract.get("connectors") ?? []
					if (resized && outlineNow && (outlineNow.widthMm !== Number(resized[1]) || outlineNow.heightMm !== Number(resized[2])))
						return propose("outline", { ...outlineNow, widthMm: Number(resized[1]), heightMm: Number(resized[2]), sizeReason: { kind: "engineer-size", detail: `the engineer drew the board ${resized[1]}×${resized[2]} mm in KiCad` } }, `engineer edited the board outline: ${resized[0]}`)
					const moved = connectorsNow.map((c) => {
						const m = shifts.find((x) => x[1] === c.ref)
						return m ? { ...c, edge: m[3] as typeof c.edge, offsetMm: Number(m[4]) } : c
					})
					if (shifts.length > 0 && JSON.stringify(moved) !== JSON.stringify(connectorsNow)) return propose("connectors", moved, `engineer moved ${shifts.map((m) => m[1]).join(", ")} on the board`)
					return say("board edits applied")
				}
				// "add a temperature/humidity sensor": a requirement line, then the sensor's I2C pins (parts adds the part).
				if (ADD_SENSOR_REQUEST.test(instruction.split("\n")[1] ?? "")) {
					const requirements = state().contract.get("requirements")
					const pins = state().contract.get("pins") ?? []
					if (step < 2 && requirements && !requirements.peripherals.includes("i2c-sensor"))
						return propose("requirements", { ...requirements, summary: `${requirements.summary} and temperature/humidity sensing`, peripherals: [...requirements.peripherals, "i2c-sensor"] }, "engineer asked for a temperature/humidity sensor")
					if (step < 2 && !pins.some((p) => p.signal === "I2C_SDA")) return propose("pins", [...pins, ...SENSOR_PINS], "the sensor's I2C bus on GPIO8/GPIO9")
					return say("sensor and pins set")
				}
				// Whether there is a case at all is the architect's (requirements.enclosure); the case's shape is the case designer's.
				const line = instruction.split("\n")[1] ?? ""
				if (ENCLOSURE_MODE_REQUEST.test(line)) {
					const requirements = state().contract.get("requirements")
					const mode = /(add|bring back|we want) (a|the) case/i.test(line) ? "case" : enclosureFromText(line)
					if (step > 0 || !requirements || !mode || requirements.enclosure === mode) return say("housing set")
					return propose("requirements", { ...requirements, enclosure: mode }, `the engineer asked: ${line}`)
				}
				// The case designer's request; a board it needs comes back as its proposal.
				if (CASE_REQUEST.test(line)) return say("left to the case")
				const width = /(\d+(?:\.\d+)?)\s*mm wide/.exec(instruction)?.[1]
				const outline = state().contract.get("outline")
				if (step > 0 || !width || !outline) return say(width ? "outline updated" : "no outline change")
				return propose("outline", { ...outline, widthMm: Number(width), sizeReason: { kind: "engineer-size", detail: `the engineer asked for ${width} mm wide` } }, `engineer asked for ${width} mm wide`)
			}
			if (instruction.startsWith("Change request")) {
				const id = /proposalId=([\w-]+)/.exec(instruction)?.[1]
				const why = /change "rails"/.test(instruction) ? "a measurement beats the estimate" : /change "outline"/.test(instruction) ? "the board takes the size the case needs; the board build shows whether the parts still fit" : "GPIO10 is free"
				return step === 0 && id ? [toolCall("decide_change", { proposalId: id, approve: true, reason: why })] : say("decided")
			}
			// The board didn't route at this size: the same answer as a failed DRC, 2 mm wider with the build as the reason.
			const routingFail = instruction.startsWith("Build failed: the board build failed at revision") && ROUTING_FAILURE.test(instruction)
			const grown = state().contract.get("outline")
			if (routingFail && grown) {
				if (stepsTaken(items) > 0) return say("board widened")
				if (drcGrows >= 5) return say("can't route it")
				drcGrows++
				const rev = /at revision (\d+)/.exec(instruction)?.[1]
				return propose("outline", { ...grown, widthMm: grown.widthMm + 2, sizeReason: { kind: "routing", detail: `the ${grown.widthMm}×${grown.heightMm} mm board (rev ${rev}) didn't route: tscircuit left pins without a trace` } }, `2 mm wider so the router has room: the rev ${rev} board didn't route`)
			}
			if (instruction.startsWith("Brief")) {
				const field = ARCHITECT_FIELDS[step]
				// Tournament variants may cap the width: "Board must be at most <N> mm wide".
				const maxWidth = Number(/Board must be at most (\d+(?:\.\d+)?) mm wide/i.exec(instruction)?.[1] ?? Infinity)
				const design = scriptedDesignFor(instruction)
				// The brief's own size ("about 50 × 30 mm") is the engineer's: recorded as the reason the board is that big.
				const stated = /(\d+(?:\.\d+)?)\s*[×x]\s*(\d+(?:\.\d+)?)\s*mm/.exec(instruction)
				const { sizeReason: _reason, ...plain } = design.outline
				const sized = stated ? { sizeReason: { kind: "engineer-size" as const, detail: `the brief asks for about ${stated[1]} × ${stated[2]} mm` } } : {}
				const housing = enclosureFromText(instruction)
				const value = field === "outline" ? { ...plain, widthMm: Math.min(design.outline.widthMm, maxWidth), ...sized } : field === "requirements" && housing ? { ...design.requirements, enclosure: housing } : design[field]
				return field ? propose(field, value, `initial ${field} from the brief`) : say("contract drafted")
			}
			return say("noted")
		},
		"mock-parts": (items) => {
			const instruction = text(items.findLast((i) => i instanceof UserMessageItem))
			if (instruction.startsWith("Build failed:")) return say("noted")
			if (instruction.startsWith("Consistency violations for you")) {
				const parts = state().contract.get("parts") ?? []
				const linkRef = /needs its connector: a part (\w+), role connector/.exec(instruction)?.[1]
				if (stepsTaken(items) === 0 && linkRef && !parts.some((p) => p.ref === linkRef))
					return propose("parts", [...parts, { ref: linkRef, role: "connector", ...LINK_CONNECTOR }], `${linkRef}: the link's JST SH 4-pin connector (catalog)`)
				if (stepsTaken(items) === 0 && violationKinds(instruction).has("model-sensor-missing") && !parts.some((p) => p.role === "microphone"))
					return propose("parts", [...parts, MIC_PART], "the model listens: the ICS-43434 I2S microphone (catalog)")
				return say("noted")
			}
			// The beacon's parts follow its requirements: the sensor joins when they ask for one (or the engineer does).
			if (isBeacon() && (instruction.startsWith("The requirements or rails changed") || (instruction.startsWith("Change request from the engineer:") && ADD_SENSOR_REQUEST.test(instruction.split("\n")[1] ?? "")))) {
				const value = ADD_SENSOR_REQUEST.test(instruction.split("\n")[1] ?? "") ? [...BEACON_DESIGN.parts, ...SENSOR_PARTS] : beaconParts()
				const same = JSON.stringify(state().contract.get("parts")) === JSON.stringify(value)
				return stepsTaken(items) === 0 && !same ? propose("parts", value, value.some((p) => p.role === "sensor") ? "the SHT40 temperature/humidity sensor and its I2C pull-ups" : "parts from the catalog") : say("parts chosen")
			}
			if (instruction.startsWith("Change request")) {
				const id = /proposalId=([\w-]+)/.exec(instruction)?.[1]
				return stepsTaken(items) === 0 && id ? [toolCall("decide_change", { proposalId: id, approve: true, reason: "fits the catalog" })] : say("decided")
			}
			// The logger's parts, plus the microphone while the model needs one (rev 11 of the first wake-word run dropped it).
			const wanted = state().contract.get("model")?.sensor === "microphone" ? [...LOGGER_DESIGN.parts, MIC_PART] : LOGGER_DESIGN.parts
			if (stepsTaken(items) > 0) return say("parts chosen")
			return JSON.stringify(state().contract.get("parts")) === JSON.stringify(wanted) ? say("parts unchanged") : propose("parts", wanted, "parts from the catalog")
		},
		"mock-ml": (items) => {
			const instruction = text(items.findLast((i) => i instanceof UserMessageItem))
			const step = stepsTaken(items)
			const model = state().contract.get("model")
			if (instruction.startsWith("Change request from the engineer:")) {
				const request = instruction.split("\n")[1] ?? ""
				// "the wake-word data is recorded": the dataset now belongs to the sensor path the design has today.
				if (DATA_RECORDED_REQUEST.test(request) && model) {
					const data = dataOn("recorded")
					if (step > 0 || !data) return say(data ? "data recorded" : "no sensor to record")
					return propose("model", { ...model, data }, `engineer asked: ${request}`)
				}
				if (step > 0 || !WAKE_WORD_REQUEST.test(request)) return say(WAKE_WORD_REQUEST.test(request) ? "model written" : "no model change")
				return propose("model", WAKE_WORD_MODEL, `engineer asked: ${request}`)
			}
			if (instruction.startsWith("Consistency violations for you") && model && step === 0) {
				const kinds = violationKinds(instruction)
				// Each fix is the textbook one: int8 quarters float32 weights; a rate the sensor supports; a shorter window.
				if (kinds.has("model-flash") && model.quantization === "float32") return propose("model", { ...model, quantization: "int8", weightsKb: Math.ceil(model.weightsKb / 4) }, "int8 quantization: about a quarter of the float32 weights")
				if (kinds.has("model-rate")) return propose("model", { ...model, sampleRateHz: 16000 }, "16 kHz, inside the microphone's low-power range")
				if (kinds.has("model-ram")) return propose("model", { ...model, windowMs: Math.round(model.windowMs / 2), arenaKb: Math.ceil(model.arenaKb / 2) }, "half the window halves the arena")
				// The hardware moved under the training data: retraining can't happen in the run, so the honest fix is to
				// mark the data needed on the new path, which the data-collection firmware then records.
				const needed = kinds.has("model-stale") && dataOn("needed")
				if (needed) return propose("model", { ...model, data: needed }, "the sensor path changed: the data must be recorded again on the new path")
			}
			return say("model unchanged")
		},
		"mock-test": (items) => {
			const instruction = text(items.findLast((i) => i instanceof UserMessageItem))
			const step = stepsTaken(items)
			const test = state().contract.get("test")
			if (instruction.startsWith("Change request from the engineer:")) {
				const request = instruction.split("\n")[1] ?? ""
				if (step > 0 || !TEST_REQUEST.test(request)) return say(TEST_REQUEST.test(request) ? "test written" : "no test change")
				return propose("test", defaultTestSpec(state().contract.snapshot()), `engineer asked: ${request}`)
			}
			if (instruction.startsWith("Consistency violations for you") && test && step === 0) {
				const fixed = followDesign(test)
				if (JSON.stringify(fixed) !== JSON.stringify(test)) return propose("test", fixed, `the test follows the design: ${[...violationKinds(instruction)].join(", ")}`)
			}
			return say("test unchanged")
		},
		"mock-connectivity": (items) => {
			const instruction = text(items.findLast((i) => i instanceof UserMessageItem))
			const step = stepsTaken(items)
			const current = state().contract.get("connectivity")
			if (instruction.startsWith("Change request from the engineer:")) {
				const request = instruction.split("\n")[1] ?? ""
				if (step > 0 || !CONNECTIVITY_REQUEST.test(request)) return say(CONNECTIVITY_REQUEST.test(request) ? "connectivity set" : "no radio change")
				return propose("connectivity", connectivityFromRequest(request, current), `engineer asked: ${request}`)
			}
			// Wi-Fi uploads cost the battery its target: upload half as often, up to once a day.
			if (instruction.startsWith("Consistency violations for you") && step === 0 && current?.radio === "wifi" && violationKinds(instruction).has("battery-short")) {
				const next = Math.min(86400, (current.uploadPeriodS ?? 3600) * 2)
				if (next !== current.uploadPeriodS) return propose("connectivity", { ...current, uploadPeriodS: next }, `uploads every ${next / 3600} h: each one joins Wi-Fi for seconds, and the battery target can't pay for them more often`)
			}
			if (instruction.startsWith("Change request")) {
				const id = /proposalId=([\w-]+)/.exec(instruction)?.[1]
				return step === 0 && id ? [toolCall("decide_change", { proposalId: id, approve: true, reason: "the radio still fits" })] : say("decided")
			}
			return say("radio unchanged")
		},
		"mock-enclosure": (items) => {
			const instruction = text(items.findLast((i) => i instanceof UserMessageItem))
			const step = stepsTaken(items)
			const s = state().contract.snapshot()
			const current = s.values.case
			if (instruction.startsWith("Change request from the engineer:")) {
				const request = instruction.split("\n")[1] ?? ""
				if (!CASE_REQUEST.test(request) || !s.values.outline) return say("no case change")
				// Whether there is a case at all is the architect's; with none of ours, there is no case to change.
				if (ENCLOSURE_MODE_REQUEST.test(request) || (s.values.requirements?.enclosure ?? "case") !== "case") return say("no case of ours")
				const last = text(items.findLast((i) => i instanceof FunctionCallOutputItem))
				if (last.startsWith("rejected")) return say("board kept as is")
				if (step === 0) {
					const value = caseFromRequest(request, s)
					if (JSON.stringify(value) !== JSON.stringify(caseOf(s)) || !current) return propose("case", value, `engineer asked: ${request}`)
				}
				// The outer size follows the board: the board the case needs, asked of the architect (and the engineer).
				const outer = requestedCaseWidth(request)
				const board = outer === null ? null : boardWidthFor(outer, s)
				if (step < 2 && board !== null && board !== s.values.outline.widthMm) return propose("outline", { ...s.values.outline, widthMm: board, sizeReason: { kind: "engineer-size", detail: `the engineer asked for a ${outer} mm wide case` } }, `a ${outer} mm wide case holds a ${board} mm board (2 mm clearance and ${caseOf(s).wallMm} mm walls each side, and the antenna's reach)`)
				return say("case updated")
			}
			if (instruction.startsWith("Consistency violations for you") && current && step === 0) {
				const fixed = caseFollows(s)
				if (JSON.stringify(fixed) !== JSON.stringify(current)) return propose("case", fixed, `the case follows the board: ${[...violationKinds(instruction)].join(", ")}`)
				return say("no case fix")
			}
			if (instruction.startsWith("Change request")) {
				const id = /proposalId=([\w-]+)/.exec(instruction)?.[1]
				return step === 0 && id ? [toolCall("decide_change", { proposalId: id, approve: true, reason: "the case still fits" })] : say("decided")
			}
			return say("case unchanged")
		},
		// Passes with one minor finding, so mock runs settle and still show a verdict.
		"mock-reviewer": (items) =>
			stepsTaken(items) === 0
				? [
						toolCall("submit_review", {
							verdict: "pass",
							findings: [
								{
									severity: "minor",
									fields: ["rails", "parts"],
									issue: "The battery budget assumes one phone connection a day; the brief does not say how often the history is read.",
									suggestion: "State the expected phone use in the brief, so the battery-life target is checked against it.",
								},
							],
						}),
					]
				: say("review submitted"),
		"mock-firmware": (items) => {
			const instruction = text(items.findLast((i) => i instanceof UserMessageItem))
			if (instruction.startsWith("Change request from the engineer:")) {
				// The request is the line after the prefix. "blink faster when tilted": a 250 ms blink past 20°, slow enough
				// that the bench can still time it from 50 ms telemetry samples (bench/blink.ts).
				const request = instruction.split("\n")[1] ?? ""
				if (stepsTaken(items) > 0 || !/blink/i.test(request)) return say(/blink/i.test(request) ? "behavior updated" : "no behavior change")
				const current = state().contract.get("behavior") ?? DEFAULT_BEHAVIOR
				const value = /tilt/i.test(request) ? { ...current, tiltBlinkMs: 250, tiltDeg: 20 } : { ...current, blinkMs: Math.max(100, Math.round(current.blinkMs / 2)) }
				return propose("behavior", value, `engineer asked: ${request}`)
			}
			if (stepsTaken(items) > 0) return say("requested")
			const pins = state().contract.get("pins") ?? []
			return pins.some((p) => p.signal === "STATUS_LED") ? say("pins are sufficient") : propose("pins", [...pins, STATUS_LED], "firmware drives a status LED")
		},
	}
}
