import type { Plan } from "../system/plan.ts"
export interface PlanDiff {
	added: string[]
	removed: string[]
	changed: string[]
}
export function planDiff(before: Plan, after: Plan): PlanDiff
