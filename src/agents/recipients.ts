import type { AgentRole, FieldName } from "../contract/types.ts"

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
