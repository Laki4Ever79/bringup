import { LOGGER_DESIGN } from "../inference/scripts.ts"
import type { ArtifactKind } from "../events.ts"
import type { AgentRole, ContractSnapshot, ContractValues, FieldName } from "../contract/types.ts"

// One contract write a change makes, by the field's owner.
export interface ChangeProposal {
	field: FieldName
	value: ContractValues[FieldName]
	by: AgentRole
}

export interface ExperimentChange {
	id: string
	label: string
	// Arm B: the one domain that hears of the change and rebuilds; the others keep building from their own copy.
	receiver: ArtifactKind
	proposals: (s: ContractSnapshot) => ChangeProposal[]
}

// The design the mock agents settle on (briefs/logger.md --mock): LOGGER_DESIGN plus the status LED the firmware
// reviewer asks for.
export function settledBase(): Pick<ContractValues, "requirements" | "outline" | "connectors" | "rails" | "parts" | "pins"> {
	const { requirements, outline, connectors, rails, parts, pins } = structuredClone(LOGGER_DESIGN)
	return { requirements, outline, connectors, rails, parts, pins: [...pins, { signal: "STATUS_LED", gpio: 10, partRef: "D1", partPin: "A" }] }
}

const value = <F extends FieldName>(s: ContractSnapshot, f: F) => structuredClone(s.values[f]) as ContractValues[F]

// The fixed change requests, one per trial. Each is what the owning agent would write for the request.
export const CHANGES: ExperimentChange[] = [
	{
		id: "narrower",
		label: "Make the board 10 mm narrower",
		receiver: "board",
		proposals: (s) => {
			const o = value(s, "outline")
			return [{ field: "outline", value: { ...o, widthMm: o.widthMm - 10 }, by: "architect" }]
		},
	},
	{
		id: "taller",
		label: "Make the board 6 mm taller",
		receiver: "enclosure",
		proposals: (s) => {
			const o = value(s, "outline")
			return [{ field: "outline", value: { ...o, heightMm: o.heightMm + 6 }, by: "architect" }]
		},
	},
	{
		id: "usb-edge",
		label: "Move the USB-C port to the bottom edge",
		receiver: "board",
		proposals: (s) => {
			const width = value(s, "outline").widthMm
			const connectors = value(s, "connectors").map((c) => (c.kind === "usb-c" ? { ...c, edge: "bottom" as const, offsetMm: width / 2 } : c))
			return [{ field: "connectors", value: connectors, by: "architect" }]
		},
	},
	{
		id: "i2c-pins",
		label: "Move the sensor's I2C bus to GPIO4/GPIO5",
		receiver: "firmware",
		proposals: (s) => {
			const moved: Record<string, number> = { I2C_SDA: 4, I2C_SCL: 5 }
			return [{ field: "pins", value: value(s, "pins").map((p) => (p.signal in moved ? { ...p, gpio: moved[p.signal] } : p)), by: "architect" }]
		},
	},
	{
		id: "add-button",
		label: "Add a user button (GPIO3, reachable through the case)",
		receiver: "firmware",
		proposals: (s) => {
			const width = value(s, "outline").widthMm
			return [
				{ field: "parts", value: [...value(s, "parts"), { ref: "SW1", role: "button", mpn: "TS-1187A-B-A-B", lcsc: "C318884", footprint: "pushbutton", pins: ["A", "B"] }], by: "parts" },
				{ field: "pins", value: [...value(s, "pins"), { signal: "BUTTON", gpio: 3, partRef: "SW1", partPin: "A" }], by: "architect" },
				{ field: "connectors", value: [...value(s, "connectors"), { ref: "SW1", kind: "button", edge: "top", offsetMm: width / 2, widthMm: 4, heightMm: 3 }], by: "architect" },
			]
		},
	},
]
