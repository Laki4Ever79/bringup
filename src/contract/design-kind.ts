// What kind of design a contract is, from its fields: a CNC (cnc or cncTargets), an arm (arm or armTargets), a wheeled
// robot (motion or mechanics), or a board alone. The run's budgets and the plan's estimates follow the kind, not a list
// of fields each place keeps (real CNC runs 1 and 2, 27 Nov 2026: the 40-revision budget a robot gets checked motion
// alone, so an arm or a CNC stopped at 25 with its board still building).
import type { ContractValues } from "./types.ts"

export type DesignKind = "cnc" | "arm" | "rover" | "board"
export const DESIGN_KINDS: DesignKind[] = ["cnc", "arm", "rover", "board"]

export function designKind(v: Partial<ContractValues> | undefined | null): DesignKind {
	if (!v) return "board"
	if (v.cnc || v.cncTargets) return "cnc"
	if (v.arm || v.armTargets) return "arm"
	if (v.motion || v.mechanics) return "rover"
	return "board"
}

// A machine (anything that moves): more fields than a board alone, drafted after it, so a longer budget.
export const isMachine = (k: DesignKind) => k !== "board"

// The kind a brief asks for, before any contract exists (the plan's estimate): the same words the scripted designs and
// the architect's prompt key on. An estimate only: the agents decide the real kind.
export function briefKind(brief: string): DesignKind {
	if (/\bCNC\b|\bengraver\b|\bplotter\b|\bmilling\b|\bspindle\b/i.test(brief)) return "cnc"
	if (/\b(robot(ic)? )?arm\b/i.test(brief) && /\bpick|\bplace|\bgrip|\breach\b/i.test(brief)) return "arm"
	if (/\brover\b|\bwheel(s|ed)?\b|\beurobot\b|\bdrive train\b/i.test(brief)) return "rover"
	return "board"
}
