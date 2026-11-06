import { radioFigures, regulatorRating } from "./power.ts"
import type { AgentRole, Connectivity, ContractSnapshot, FieldName } from "./types.ts"

// Without a connectivity field the device is what it always was: Bluetooth LE, its GATT service, no field updates.
export const DEFAULT_CONNECTIVITY: Readonly<Connectivity> = Object.freeze({ radio: "ble", report: Object.freeze(["gatt"]) as unknown as Connectivity["report"], updates: "none" })
export const connectivityOf = (s: ContractSnapshot): Connectivity => s.values.connectivity ?? structuredClone(DEFAULT_CONNECTIVITY as Connectivity)

const REPORTS = { gatt: "ble", bthome: "ble", mqtt: "wifi" } as const
// Connecting to Wi-Fi often costs more than the reading itself, so uploads are batched; once a minute at most.
export const MIN_UPLOAD_PERIOD_S = 60

export const CONNECTIVITY_SHAPE = `connectivity must be {radio: "ble"|"wifi", report: one or more of "gatt" (a phone reads the history; BLE), "bthome" (BTHome v2 broadcast Home Assistant reads; BLE), "mqtt" (MQTT with Home Assistant discovery; Wi-Fi), uploadPeriodS (Wi-Fi only, required: seconds between uploads, at least ${MIN_UPLOAD_PERIOD_S}), updates: "none"|"ota" ("ota" needs Wi-Fi)}`

export function connectivityShapeError(value: unknown): string | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return CONNECTIVITY_SHAPE
	const v = value as Record<string, unknown>
	if (v.radio !== "ble" && v.radio !== "wifi") return CONNECTIVITY_SHAPE
	if (!Array.isArray(v.report) || v.report.length === 0 || !v.report.every((r) => typeof r === "string" && r in REPORTS) || new Set(v.report).size !== v.report.length) return CONNECTIVITY_SHAPE
	const wrong = (v.report as (keyof typeof REPORTS)[]).filter((r) => REPORTS[r] !== v.radio)
	if (wrong.length > 0) return `${CONNECTIVITY_SHAPE}; ${wrong.join(", ")} needs ${REPORTS[wrong[0]] === "ble" ? "Bluetooth LE" : "Wi-Fi"}, not ${v.radio}`
	if (v.updates !== "none" && v.updates !== "ota") return CONNECTIVITY_SHAPE
	if (v.updates === "ota" && v.radio !== "wifi") return `${CONNECTIVITY_SHAPE}; updates "ota" downloads over Wi-Fi`
	if (v.radio === "wifi" && !(typeof v.uploadPeriodS === "number" && Number.isFinite(v.uploadPeriodS) && v.uploadPeriodS >= MIN_UPLOAD_PERIOD_S)) return `${CONNECTIVITY_SHAPE}; Wi-Fi needs uploadPeriodS`
	if (v.radio === "ble" && v.uploadPeriodS !== undefined) return `${CONNECTIVITY_SHAPE}; uploadPeriodS is for Wi-Fi`
	return null
}

// ---- flash: the partition table follows the update choice ------------------------------------------------------

// Arduino-ESP32's stock 4 MB tables (tools/partitions; identical at tags 3.0.0, 3.3.0 and master). "default.csv"
// keeps two 1.25 MB firmware slots, so an update can be written beside the running firmware; "no_ota.csv" one 2 MB
// slot. Without a connectivity field the firmware keeps default.csv, as it always had (its second slot unused).
export const PARTITION_LAYOUTS = {
	"default.csv": { appBytes: 0x140000, fsBytes: 0x160000, slots: 2 },
	"no_ota.csv": { appBytes: 0x200000, fsBytes: 0x1e0000, slots: 1 },
} as const
export type PartitionTable = keyof typeof PARTITION_LAYOUTS

export function partitionTable(s: ContractSnapshot): PartitionTable {
	const c = s.values.connectivity
	return !c || c.updates === "ota" ? "default.csv" : "no_ota.csv"
}

export const partitionLayout = (s: ContractSnapshot) => ({ table: partitionTable(s), ...PARTITION_LAYOUTS[partitionTable(s)] })

// ---- power: the radio's peak, and the supply it needs ----------------------------------------------------------

export type ConnectivityViolationKind = "supply-underrated"

export interface ConnectivityViolation {
	kind: ConnectivityViolationKind
	message: string
	fields: FieldName[]
	affects: AgentRole[]
}

// The radio's transmit peak, which the 3V3 rail's loadMa must cover: Bluetooth LE at 0 dBm, or Wi-Fi.
export function radioPeakMa(s: ContractSnapshot): { ma: number; what: string; source: string } | null {
	const r = radioFigures(s)
	if (!r) return null
	return connectivityOf(s).radio === "wifi"
		? { ma: r.wifiTxMa, what: `${r.ref} ${r.mpn} transmitting Wi-Fi`, source: r.source }
		: { ma: r.bleTxMa, what: `${r.ref} ${r.mpn} transmitting Bluetooth LE at 0 dBm`, source: r.source }
}

// The module's datasheet asks for a supply that can deliver supplyMinMa (ESP32-C3-MINI-1: 0.5 A), whatever the
// radio: its transmit bursts are short and high. A regulator rated below it browns the module out on a burst.
export function connectivityChecks(s: ContractSnapshot): ConnectivityViolation[] {
	const r = radioFigures(s)
	const ldo = (s.values.parts ?? []).find((p) => p.role === "ldo")
	const rating = ldo ? regulatorRating(ldo) : null
	if (!r || !ldo || !rating || rating.maxMa >= r.supplyMinMa) return []
	return [
		{
			kind: "supply-underrated",
			message: `${ldo.ref} ${ldo.mpn} is rated ${rating.maxMa} mA (${rating.source}), but ${r.ref} ${r.mpn} needs a supply that can deliver ${r.supplyMinMa} mA (${r.source}): its radio bursts brown out a smaller regulator. Pick a regulator rated ${r.supplyMinMa} mA or more`,
			fields: ["parts"],
			affects: ["parts"],
		},
	]
}
