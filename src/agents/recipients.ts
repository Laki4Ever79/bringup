import { OWNERS, type AgentRole, type FieldName } from "../contract/types.ts"

// Who a violation wakes (26 Nov 2026). Every agent wakes on the violations addressed to it, never on a kind's name: a
// new domain's checks (an arm's arm-*, a CNC's cnc-*, a future lathe's) reach their owner with no edit here. Before,
// the mechanics agent listened only for mech-*, so the arm's and the CNC's findings, and ros-package and the stall-sag
// check addressed to it, woke nobody.

// The roles that run as agents and take violations: violationsFor in roles.ts, and the architect's and firmware's own
// handlers. Not here: the board and the case builders (they rebuild on every contract change), the integrator (a
// system run's architect, outside a board run's agents), the engineer, the reviewer and the bench.
export const VIOLATION_ROLES: readonly AgentRole[] = ["architect", "parts", "firmware", "ml", "test", "mechanics", "enclosure", "connectivity"]

// A violation's recipients: the agents among the roles it affects; when none of those is an agent (a builder's
// mismatch, a system role in a board run), the owners of the fields it names, so it never goes unanswered.
export function recipients(v: { affects: readonly AgentRole[]; fields: readonly FieldName[] }): AgentRole[] {
	const direct = v.affects.filter((r) => VIOLATION_ROLES.includes(r))
	if (direct.length) return [...new Set(direct)]
	return [...new Set(v.fields.map((f) => OWNERS[f]).filter((r) => VIOLATION_ROLES.includes(r)))]
}
