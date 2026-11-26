import type { Tool } from "@mozaik-ai/core"
import { completePowerTree } from "../contract/power-auto.ts"
import { withArmRails } from "../contract/arm-rails.ts"
import { moveUpMcu } from "../contract/mcu-move.ts"
import { withRobotImu } from "../contract/imu-auto.ts"
import { withDriverOutputs } from "../contract/outputs-auto.ts"
import { withStatusLed } from "../contract/status-led-auto.ts"
import { FIELDS, OWNERS, type AgentRole, type ContractSnapshot, type ContractValues, type FieldName } from "../contract/types.ts"
import { makeEvent, type Cause } from "../events.ts"
import { causeOf } from "./common.ts"
import { emit, state } from "../runtime.ts"
import { defaultCheckCatalog } from "../mechanics/checks.ts"
import { laidOut } from "../mechanics/solve.ts"
import { loadCatalog } from "../tools/parts-search.ts"
import { fileURLToPath } from "node:url"
import { connectorsOntoEdges } from "../contract/consistency.ts"
import { compactOutline, minimumBoard, placesAll, scaledConnectors, sizeOf } from "../contract/space.ts"
import { connectorsForParts, ESTOP_PLUG_REF, isEncoderPlug, isMotorPlug, MOTOR_PLUG_REFS, robotRefs, SENSOR_PLUG_REF, START_PLUG_REF } from "../mechanics/refs.ts"

// Tools every agent gets for reading and changing the shared design contract.
// `self.id` is filled in once the agent exists, so events carry the agent as producer.
const mcuCatalog = () => loadCatalog(fileURLToPath(new URL("../..", import.meta.url))) as never

export function contractTools(role: AgentRole, self: { id: string }): Tool[] {
	return [
		{
			type: "function",
			name: "read_contract",
			description: "Read the current design contract: every field with its value and version.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			strict: false,
			invoke: async () => state().contract.snapshot(),
		},
		{
			type: "function",
			name: "propose_contract_change",
			description:
				"Replace one contract field. baseVersion must be the field's current version. Changes to fields you do not own are held until their owner approves.",
			parameters: {
				type: "object",
				properties: {
					field: { type: "string", enum: [...FIELDS] },
					value: { description: "The complete new value for the field." },
					baseVersion: { type: "integer" },
					reason: { type: "string" },
					approvalId: { type: "string" },
				},
				required: ["field", "value", "baseVersion", "reason"],
			},
			strict: false,
			invoke: async (args: { field: FieldName; value: ContractValues[FieldName]; baseVersion: number; reason: string; approvalId?: string }) => {
				const s = state()
				const approvedBy = args.approvalId ? s.approvals.approverOf(args.approvalId, args.field, role, JSON.stringify(args.value)) : undefined
				const before = s.contract.get(args.field) ?? null
				// A robot's mechanics: the parts are the engineer's, the layout the chassis solver's when the proposed one fails.
				let laidOutNote: string | null = null
				if (args.field === "mechanics") {
					const cat = defaultCheckCatalog()
					if (cat) {
						const l = laidOut(s.contract.snapshot(), args.value as ContractValues["mechanics"], cat)
						if (l.refusal) return { status: "invalid", reason: l.refusal }
						args = { ...args, value: l.mechanics as ContractValues[FieldName] }
						laidOutNote = l.note
					}
					// The sensor's plug has a fixed name (src/mechanics/refs.ts).
					const m = args.value as ContractValues["mechanics"]
					if (m?.sensor && m.sensor.connector !== SENSOR_PLUG_REF) {
						args = { ...args, value: { ...m, sensor: { ...m.sensor, connector: SENSOR_PLUG_REF } } as ContractValues[FieldName] }
						laidOutNote = [laidOutNote, `the sensor's plug is always ${SENSOR_PLUG_REF} (fixed name), not ${m.sensor.connector}`].filter(Boolean).join("; ")
					}
					// The emergency stop's and the start cord's plugs too.
					const v = args.value as ContractValues["mechanics"]
					const safety = v?.safety
					if (safety && ((safety.estop && safety.estop.connector !== ESTOP_PLUG_REF) || (safety.start && safety.start.connector !== START_PLUG_REF))) {
						const was = [safety.estop && safety.estop.connector !== ESTOP_PLUG_REF ? `${safety.estop.connector} → ${ESTOP_PLUG_REF}` : null, safety.start && safety.start.connector !== START_PLUG_REF ? `${safety.start.connector} → ${START_PLUG_REF}` : null].filter(Boolean)
						args = { ...args, value: { ...v, safety: { ...safety, ...(safety.estop ? { estop: { ...safety.estop, connector: ESTOP_PLUG_REF } } : {}), ...(safety.start ? { start: { ...safety.start, connector: START_PLUG_REF } } : {}) } } as ContractValues[FieldName] }
						laidOutNote = [laidOutNote, `the e-stop's plug is always ${ESTOP_PLUG_REF} and the start cord's ${START_PLUG_REF} (fixed names): ${was.join(", ")}`].filter(Boolean).join("; ")
					}
				}
				// An encoder gearmotor's plugs are the catalog's 6-pin SH (motor and encoder on one plug): a 2-pin motor plug is
				// swapped for it, ref kept (run cc-eurobot-13: the parts agent switched JM1/JM2 between 2-pin and 6-pin four times).
				if (args.field === "parts" && Array.isArray(args.value) && s.contract.get("motion")) {
					const mech = s.contract.get("mechanics")
					const cat = defaultCheckCatalog()
					const motor = mech && cat ? cat.mech.motors.find((m) => m.mpn === mech.drive?.motor || m.mpn.startsWith(`${mech.drive?.motor} `)) : undefined
					const sh6 = motor && (motor as { encoder?: unknown }).encoder ? loadCatalog(fileURLToPath(new URL("../..", import.meta.url))).find((c) => c.mpn === "SM06B-SRSS-TB(LF)(SN)") : undefined
					const list = args.value as ContractValues["parts"]
					const plain = list.filter((p) => isMotorPlug(p) && !isEncoderPlug(p) && (MOTOR_PLUG_REFS as readonly string[]).includes(p.ref))
					if (sh6 && plain.length) {
						args = { ...args, value: list.map((p) => (plain.includes(p) ? { ...p, mpn: sh6.mpn, lcsc: sh6.lcsc ?? null, footprint: sh6.footprint ?? p.footprint, pins: [...(sh6.pins ?? [])] } : p)) as ContractValues[FieldName] }
						laidOutNote = [laidOutNote, `${plain.map((p) => p.ref).join(" and ")} became the 6-pin SH plug ${sh6.mpn} the encoder motor needs (one plug for motor and encoder)`].filter(Boolean).join("; ")
					}
				}
				// A robot's power tree is decided in code from its pack and regulator (contract/power-auto.ts): every parts write
				// lands it complete (real run 19b spent 19 revisions on it by hand).
				// A CNC (cncTargets): its logic's 5 V from the brick, the power tree decided in code as an arm's is (CNC gap 6).
				if (args.field === "parts" && Array.isArray(args.value) && !s.contract.get("motion") && !s.contract.get("arm") && s.contract.get("cncTargets")) {
					const t = completePowerTree(args.value as NonNullable<ContractValues["parts"]>, undefined, s.contract.snapshot())
					if (t.note) {
						args = { ...args, value: t.parts as ContractValues[FieldName] }
						laidOutNote = [laidOutNote, t.note].filter(Boolean).join("; ")
					}
				}
				if (args.field === "parts" && Array.isArray(args.value) && (s.contract.get("motion") || s.contract.get("arm"))) {
					// A PWM driver comes with its servo plugs, their supply and the spare motor (contract/outputs-auto.ts; run 20b);
					// on an arm, a plug per servo, its rails and the brick's jack (power-auto.ts armOutputs).
					const o = withDriverOutputs(args.value as NonNullable<ContractValues["parts"]>, mcuCatalog(), s.contract.get("mechanics"), s.contract.get("arm"))
					if (o.note) {
						args = { ...args, value: o.parts as ContractValues[FieldName] }
						laidOutNote = [laidOutNote, o.note].filter(Boolean).join("; ")
					}
					const t = completePowerTree(args.value as NonNullable<ContractValues["parts"]>, s.contract.get("mechanics") ?? undefined, s.contract.snapshot())
					if (t.note) {
						args = { ...args, value: t.parts as ContractValues[FieldName] }
						laidOutNote = [laidOutNote, t.note].filter(Boolean).join("; ")
					}
					// Every robot carries an IMU (contract/imu-auto.ts; the user, 17 Nov 2026: "Every robot").
					const i = withRobotImu(args.value as NonNullable<ContractValues["parts"]>, mcuCatalog(), s.contract.get("mechanics"))
					if (i.note) {
						args = { ...args, value: i.parts as ContractValues[FieldName] }
						laidOutNote = [laidOutNote, i.note].filter(Boolean).join("; ")
					}
				}
				// A robot's plugs have fixed names: the parts list is renamed to them, and the connectors and pins follow below.
				let renames: Record<string, string> = {}
				if (args.field === "parts" && Array.isArray(args.value) && s.contract.get("motion")) {
					const r = robotRefs(args.value as ContractValues["parts"])
					if (Object.keys(r.renames).length) {
						renames = r.renames
						args = { ...args, value: r.parts as ContractValues[FieldName] }
						laidOutNote = `a robot's plugs have fixed names (sensor ${SENSOR_PLUG_REF}, motors JM1 and JM2): renamed ${Object.entries(renames).map(([a, b]) => `${a} to ${b}`).join(", ")}; the connectors and pins follow`
					}
				}
				// Connectors: one that runs past the end of its edge or overlaps another moves along its edge to fit (rover run
				// cc-rover-4 proposed J1 and JM2 overlapping across a corner, and left them so for revisions).
				// A robot's pin on a plug that has its fixed name: the START signal goes to the start cord's plug whatever ref the
				// proposal names (run cc-eurobot-10: START → J4.START while the plug was JS1).
				if (args.field === "pins" && Array.isArray(args.value) && s.contract.get("motion")) {
					const refs = new Set((s.contract.get("parts") ?? []).map((p) => p.ref))
					const pins = args.value as ContractValues["pins"]
					if (refs.has(START_PLUG_REF) && pins.some((p) => p.signal === "START" && p.partRef !== START_PLUG_REF && !refs.has(p.partRef))) {
						args = { ...args, value: pins.map((p) => (p.signal === "START" && !refs.has(p.partRef) ? { ...p, partRef: START_PLUG_REF } : p)) as ContractValues[FieldName] }
						laidOutNote = [laidOutNote, `START goes to the start cord's plug ${START_PLUG_REF} (fixed name)`].filter(Boolean).join("; ")
					}
					// An encoder's channel lands on its motor's plug when that plug carries the encoder: ENC_L* on JM1, ENC_R* on
					// JM2 (run cc-eurobot-13: the architect sent ENC_LA/ENC_RA to invented encoder plugs JN1/JN2).
					const encPlug = (ref: string) => (s.contract.get("parts") ?? []).find((p) => p.ref === ref && isEncoderPlug(p))
					const encTo = (signal: string) => (/^ENC_L/.test(signal) ? MOTOR_PLUG_REFS[0] : /^ENC_R/.test(signal) ? MOTOR_PLUG_REFS[1] : null)
					const cur = args.value as ContractValues["pins"]
					if (cur.some((p) => encTo(p.signal) && encPlug(encTo(p.signal)!) && p.partRef !== encTo(p.signal))) {
						args = { ...args, value: cur.map((p) => { const to = encTo(p.signal); return to && encPlug(to) && p.partRef !== to ? { ...p, partRef: to, partPin: /B$/.test(p.signal) ? "ENCB" : "ENCA" } : p }) as ContractValues[FieldName] }
						laidOutNote = [laidOutNote, `the encoder channels go to the motors' own plugs ${MOTOR_PLUG_REFS.join("/")} (one plug for motor and encoder)`].filter(Boolean).join("; ")
					}
				}
				if (args.field === "connectors" && Array.isArray(args.value)) {
					const snap = s.contract.snapshot()
					// A robot's connector naming no part goes to the plug part that has no connector yet.
					if (snap.values.motion && snap.values.parts) {
						const named = connectorsForParts(args.value as ContractValues["connectors"], snap.values.parts)
						if (named) {
							const was = (args.value as ContractValues["connectors"]).map((k) => k.ref)
							laidOutNote = `connectors that named no part took the plug parts' names: ${named.map((k, i) => (k.ref !== was[i] ? `${was[i]} to ${k.ref}` : null)).filter(Boolean).join(", ")}`
							args = { ...args, value: named as ContractValues[FieldName] }
						}
					}
					const fitted = connectorsOntoEdges({ ...snap, values: { ...snap.values, connectors: args.value as ContractValues["connectors"] } }, { clearModule: true })
					if (fitted) {
						const moved = fitted.filter((k) => !(args.value as ContractValues["connectors"]).some((b) => b.ref === k.ref && b.offsetMm === k.offsetMm)).map((k) => `${k.ref} to ${k.edge}@${k.offsetMm} mm`)
						args = { ...args, value: fitted as ContractValues[FieldName] }
						laidOutNote = [laidOutNote, `moved along their edges to fit the board and clear each other: ${moved.join(", ")}`].filter(Boolean).join("; ")
					}
				}
				// A robot asking for wheel encoders whose MCU can't carry both channels of each on pins free at reset moves up
				// to one that can (contract/mcu-move.ts): this write lands moved, and the other field follows once it applies.
				let moved: { parts?: ContractValues["parts"]; pins?: ContractValues["pins"]; note: string } | null = null
				if ((args.field === "parts" || args.field === "pins") && Array.isArray(args.value) && s.contract.get("motion")) {
					const parts = args.field === "parts" ? (args.value as ContractValues["parts"]) : s.contract.get("parts")
					const pins = args.field === "pins" ? (args.value as ContractValues["pins"]) : s.contract.get("pins")
					const up = parts && pins ? moveUpMcu(parts, pins, s.contract.get("motion") ?? undefined, mcuCatalog()) : null
					if (up) {
						args = { ...args, value: (args.field === "parts" ? up.parts : up.pins) as ContractValues[FieldName] }
						moved = args.field === "parts" ? { pins: up.pins, note: up.note } : { parts: up.parts, note: up.note }
						laidOutNote = [laidOutNote, up.note].filter(Boolean).join("; ")
					}
					// Every wheeled robot's status LED (contract/status-led-auto.ts; run 20b had none).
					const curParts = args.field === "parts" ? (args.value as ContractValues["parts"]) : (moved?.parts ?? parts)
					const curPins = args.field === "pins" ? (args.value as ContractValues["pins"]) : (moved?.pins ?? pins)
					const led = curParts && curPins?.length ? withStatusLed(curParts, curPins, s.contract.get("mechanics"), s.contract.get("motion"), mcuCatalog()) : null
					if (led) {
						args = { ...args, value: (args.field === "parts" ? led.parts : led.pins) as ContractValues[FieldName] }
						const other = args.field === "parts" ? { pins: led.pins } : led.parts !== curParts ? { parts: led.parts } : {}
						moved = { ...(moved ?? {}), ...other, note: [moved?.note, led.note].filter(Boolean).join("; ") }
						laidOutNote = [laidOutNote, led.note].filter(Boolean).join("; ")
					}
				}
				// A new size that can't hold what the board carries is refused before it becomes a revision, naming the sizes
				// near it that do (real run 20: the space check said 44×35, the architect chose 46×38, which has no spot for U8,
				// though 44×35 does: placement isn't monotonic, and each such guess cost a revision and a board build).
				if (args.field === "outline" && isObjectValue(args.value)) {
					const refusal = outlineRefusal(s.contract.snapshot(), args.value as ContractValues["outline"])
					if (refusal) return { status: "invalid", reason: refusal }
				}
				const result = s.contract.propose({ field: args.field, value: args.value, by: role, baseVersion: args.baseVersion, approvedBy })
				if (result.status === "applied") {
					let carried: (() => void) | null = null
					// Before the outline's own event, so every build woken by it sees the whole revision (an enclosure built on the
					// outline event alone kept J1's cutout where the old board had it). A new outline carries its connectors in the same revision: each at the same relative place along its edge, as
					// the space model judged the size (space.ts scaledConnectors), then fitted onto its edge and clear of the others.
					// Runs 19 and 19b spent a second revision per outline change on them, and kept them where the old board had
					// them, so a size the space check called placeable didn't place.
					const oldOutline = before as ContractValues["outline"] | null
					if (args.field === "outline" && oldOutline && (s.contract.get("connectors") ?? []).length) {
						const snap = s.contract.snapshot()
						const beforeC = snap.values.connectors ?? []
						const o = args.value as ContractValues["outline"]
						const scaled = scaledConnectors({ ...snap, values: { ...snap.values, outline: oldOutline } }, o.widthMm, o.heightMm)
						const next = connectorsOntoEdges({ ...snap, values: { ...snap.values, connectors: scaled } }, { clearModule: true }) ?? scaled ?? []
						const moved = next.filter((k) => !beforeC.some((b) => b.ref === k.ref && b.edge === k.edge && b.offsetMm === k.offsetMm)).map((k) => `${k.ref} to ${k.edge}@${k.offsetMm} mm`)
						if (moved.length) {
							const why = `the new ${o.widthMm}x${o.heightMm} mm outline: each connector at the same place along its edge (the space check judged the size so): ${moved.join(", ")}`
							const owner = OWNERS.connectors
							const r = s.contract.amend({ field: "connectors", value: next, by: owner, approvedBy: owner })
							if (r.status === "applied") {
								carried = () => emit(makeEvent("contract.changed", self.id, { field: "connectors", version: r.version, revision: r.revision, by: owner, reason: why, before: beforeC, after: next, cause: { kind: "field-changed", fields: ["outline"] } }), self.id)
								laidOutNote = `connectors follow the outline in the same revision: ${moved.join(", ")}`
							}
						}
					}
					// Why: the writer's own reason, the field before and after, and what woke it (or the approval it wrote under).
					const decision = args.approvalId && approvedBy ? s.approvals.decisionOf(args.approvalId) : undefined
					const cause: Cause | undefined = decision ? { kind: "approval", proposalId: args.approvalId!, approvedBy: decision.decidedBy ?? [decision.by], reason: decision.reason } : causeOf(self.id)
					emit(makeEvent("contract.changed", self.id, { field: args.field, version: result.version, revision: result.revision, by: role, reason: args.reason, before, after: args.value, ...(cause ? { cause } : {}) }), self.id)
					;(carried as (() => void) | null)?.()
					// A change another field must follow, written as its own change by that field's owner, with its reason.
					const follow = <G extends FieldName>(field: G, value: ContractValues[G], why: string): boolean => {
						const owner = OWNERS[field]
						const beforeF = s.contract.get(field) ?? null
						const r = s.contract.propose({ field, value, by: owner, baseVersion: s.contract.version(field), approvedBy: owner })
						if (r.status !== "applied") return false
						emit(makeEvent("contract.changed", self.id, { field, version: r.version, revision: r.revision, by: owner, reason: why, before: beforeF, after: value, cause: { kind: "field-changed", fields: [args.field] } }), self.id)
						return true
					}
					// The other field of an MCU move-up made on this write (below, before propose).
					if (moved?.pins) follow("pins", moved.pins, moved.note)
					if (moved?.parts) follow("parts", moved.parts, moved.note)
					// A new pack regenerates the power tree, and a robot asking for wheel encoders moves its MCU up when it can't
					// carry both channels (contract/mcu-move.ts): one parts write as the parts owner's own change, and the pins
					// the move needs, in the same step (real run 19b: the switch to the 2S pack at revision 17 left the 1-cell
					// charger on the board until the agents found it).
					if ((args.field === "mechanics" || args.field === "motion") && s.contract.get("motion")) {
						const mech = args.field === "mechanics" ? (args.value as ContractValues["mechanics"]) : s.contract.get("mechanics")
						const before = s.contract.get("parts")
						const outs = before ? withDriverOutputs(before, mcuCatalog(), mech) : null
						const parts = outs?.note ? outs.parts : before
						const pins = s.contract.get("pins")
						const t = parts && (args.field === "mechanics" || outs?.note) ? completePowerTree(parts, mech ?? undefined, s.contract.snapshot()) : null
						const powered = t?.note ? t.parts : parts
						const imu = powered ? withRobotImu(powered, mcuCatalog(), mech) : null
						const tree = imu?.note ? imu.parts : powered
						const up = tree && pins ? moveUpMcu(tree, pins, s.contract.get("motion") ?? undefined, mcuCatalog()) : null
						const why = [outs?.note, t?.note ? (args.field === "mechanics" ? `the pack changed: ${t.note}` : t.note) : null, imu?.note, up?.note].filter(Boolean).join("; ")
						if (why && follow("parts", up?.parts ?? tree!, why)) {
							if (up) follow("pins", up.pins, up.note)
							laidOutNote = [laidOutNote, why].filter(Boolean).join("; ")
						}
					}
					// An arm's change (a servo swapped, the rail or the brick changed) regenerates its servo plugs, rails and input
					// in the same step, as a new pack does a rover's power tree.
					if (args.field === "arm" && s.contract.get("parts")) {
						const arm = args.value as ContractValues["arm"]
						const snap = s.contract.snapshot()
						const outs = withDriverOutputs(s.contract.get("parts")!, mcuCatalog(), null, arm)
						const t = completePowerTree(outs.parts, undefined, { ...snap, values: { ...snap.values, arm } })
						const why = [outs.note, t.note].filter(Boolean).join("; ")
						if (why && follow("parts", t.parts, `the arm changed: ${why}`)) laidOutNote = [laidOutNote, why].filter(Boolean).join("; ")
					}
					// An arm's servo rails and brick input go into the contract's rails with their peak, sized like any rail
					// (lead-2, 26 Nov 2026), on any write that changes them (the arm, its parts, the rails themselves).
					if (s.contract.get("arm") && (args.field === "arm" || args.field === "parts" || args.field === "rails")) {
						const snap = s.contract.snapshot()
						const before = snap.values.rails ?? []
						const rails = withArmRails(before, snap)
						if (JSON.stringify(rails) !== JSON.stringify(before)) {
							const why = `the arm's rails at their peak: ${rails.filter((r) => !before.some((b) => JSON.stringify(b) === JSON.stringify(r))).map((r) => `${r.name} ${r.voltageV} V ${r.loadMa} mA`).join(", ")}`
							if (follow("rails", rails, why)) laidOutNote = [laidOutNote, why].filter(Boolean).join("; ")
						}
					}
					// Renamed plugs: the connectors and pins that named the old refs take the new ones.
					if (Object.keys(renames).length) {
						const to = (ref: string) => renames[ref] ?? ref
						const why = `the parts' plugs took their fixed names (${Object.entries(renames).map(([a, b]) => `${a} to ${b}`).join(", ")})`
						const conns = s.contract.get("connectors")
						if (conns?.some((k) => renames[k.ref])) {
							const renamed = conns.map((k) => ({ ...k, ref: to(k.ref) }))
							follow("connectors", connectorsForParts(renamed, args.value as ContractValues["parts"]) ?? renamed, why)
						}
						const pins = s.contract.get("pins")
						if (pins?.some((p) => renames[p.partRef])) follow("pins", pins.map((p) => ({ ...p, partRef: to(p.partRef) })), why)
					}
				}
				return laidOutNote && result.status === "applied" ? { ...result, note: laidOutNote } : result
			},
		},
		{
			type: "function",
			name: "decide_change",
			description: "Approve or reject a held change request to a field you own.",
			parameters: {
				type: "object",
				properties: { proposalId: { type: "string" }, approve: { type: "boolean" }, reason: { type: "string" } },
				required: ["proposalId", "approve", "reason"],
			},
			strict: false,
			invoke: async (args: { proposalId: string; approve: boolean; reason: string }) => {
				const field = state().approvals.fieldOf(args.proposalId)
				if (!field) return `unknown proposalId "${args.proposalId}"`
				if (OWNERS[field] !== role) return `not the owner of "${field}" (${OWNERS[field]} decides)`
				if (state().approvals.hasVoted(args.proposalId, role)) return "already voted on this proposal"
				const earlier = state().approvals.decisionOf(args.proposalId)
				if (earlier) return `already decided (${earlier.approved ? "approved" : "rejected"}: ${earlier.reason})`
				emit(makeEvent("change.decided", self.id, { proposalId: args.proposalId, approved: args.approve, by: role, reason: args.reason }), self.id)
				return "recorded"
			},
		},
	]
}

const isObjectValue = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

// Why a proposed outline can't be taken: the board it makes has no spot for something it carries (placesAll, with the
// connectors where the change will put them). The answer names the placing sizes nearest the one asked for, and the
// smallest. Null when it places, or when there is nothing to place yet (no outline or no parts: the first outline).
export function outlineRefusal(snap: ContractSnapshot, next: ContractValues["outline"]): string | null {
	const o = snap.values.outline
	if (!o || !snap.values.parts?.length || !next || !(next.widthMm > 0) || !(next.heightMm > 0)) return null
	if (placesAll(snap, next.widthMm, next.heightMm)) return null
	const min = minimumBoard(snap)
	const near = (min?.shapes ?? [])
		.map((x) => ({ ...x, d: Math.abs(x.widthMm - next.widthMm) + Math.abs(x.heightMm - next.heightMm) }))
		.sort((a, b) => a.d - b.d || a.widthMm * a.heightMm - b.widthMm * b.heightMm)
		.slice(0, 3)
		.map((x) => `${x.widthMm}×${x.heightMm}`)
	return `a ${next.widthMm}×${next.heightMm} mm board has no spot for everything it carries (the placer, with the connectors where this change puts them)${near.length ? `; sizes near it that place: ${near.join(", ")} mm` : ""}${min ? `; the smallest: ${sizeOf(compactOutline(snap), min)}` : ""}. A bigger board isn't always the answer: placement isn't monotonic, so pick one of these`
}
