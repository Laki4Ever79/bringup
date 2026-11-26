import { OWNERS, type AgentRole, type FieldName } from "../contract/types.ts"

// Who a violation wakes (26 Nov 2026). Every agent wakes on the violations addressed to it, never on a kind's name: a
// new domain's checks (an arm's arm-*, a CNC's cnc-*, a future lathe's) reach their owner with no edit here. Before,
// the mechanics agent listened only for mech-*, so the arm's and the CNC's findings, and ros-package and the stall-sag
// check addressed to it, woke nobody.

// The roles that run as agents and take violations: violationsFor in roles.ts, and the architect's and firmware's own
// handlers. Not here: the board and the case builders (they rebuild on every contract change), the integrator (a
// system run's architect, outside a board run's agents), the engineer, the reviewer and the bench.
export const VIOLATION_ROLES: readonly AgentRole[] = ["architect", "parts", "firmware", "ml", "test", "mechanics", "enclosure", "connectivity"]

// A violation's recipients: the agents among the roles it affects. No fallback to the fields' owners: a violation
// addressed to no agent is deliberate. `affects: []` or a builder ("board") marks a built artifact that disagrees with a
// contract that moved on: the rebuild clears it, and waking an owner then only spends a turn (rover mock, 26 Nov 2026:
// the fallback woke the architect twice, the parts and the mechanics agents once each, at the revision before the
// board's rebuild: 9 → 13 turns for the same settled design).
export function recipients(v: { affects: readonly AgentRole[]; fields?: readonly FieldName[] }): AgentRole[] {
	return [...new Set(v.affects.filter((r) => VIOLATION_ROLES.includes(r)))]
}

// The agent that answers for a built artifact's disagreement once that artifact is current: its own agent when it has
// one; the board's builder has none, so a board's goes to the owners of the fields it names.
const ARTIFACT_AGENT: Record<string, AgentRole | null> = { firmware: "firmware", chassis: "mechanics", enclosure: "enclosure", board: null }

// Violations that wait on a rebuild (waitsOn) and reach no agent, once that artifact is built for the current contract
// and still disagrees: handed to an owner, never left addressed to nobody (an arm mock with hardware, 26 Nov 2026: the
// arm firmware didn't declare STATUS_LED, "pin-mismatch: firmware drives STATUS_LED on ?" had affects [] and stayed to
// the end with no one woken). While the artifact is behind, they wait as before.
export function routeWaiting<V extends { affects: AgentRole[]; fields: FieldName[]; message: string; waitsOn?: string }>(violations: V[], isCurrent: (kind: string) => boolean): V[] {
	return violations.map((v) => {
		if (!v.waitsOn || recipients(v).length || !isCurrent(v.waitsOn)) return v
		const own = ARTIFACT_AGENT[v.waitsOn]
		const to = own ? [own] : [...new Set(v.fields.map((f) => OWNERS[f]).filter((r) => VIOLATION_ROLES.includes(r)))]
		return to.length ? { ...v, affects: to, message: `${v.message} (the ${v.waitsOn} built for this revision still disagrees: not a rebuild's to fix)` } : v
	})
}
