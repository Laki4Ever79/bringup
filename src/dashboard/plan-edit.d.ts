import type { Plan } from "../system/plan.ts"
export interface PlanDiff {
	added: string[]
	removed: string[]
	changed: string[]
}
export function planDiff(before: Plan, after: Plan): PlanDiff
export function moveBoard(plan: Plan, name: string, x: number, y: number): Plan
export function addBoard(plan: Plan, name: string, brief: string): Plan
export function removeBoard(plan: Plan, name: string): Plan
export function removeLink(plan: Plan, id: string): Plan
export function connect(plan: Plan, a: string, b: string, kind: "uart" | "i2c"): Plan
export function setBrief(plan: Plan, name: string, brief: string): Plan
