import type { Plan } from "../system/plan.ts"
import type { PlanView } from "./plans.ts"
export interface PlanCanvas {
	// A plan view from the hub (a save's answer, a change in words, a reload): the drawing follows it.
	apply(v: PlanView): void
	// Fetches the plan again, applies it and reports it through onView.
	reload(): Promise<void>
	// Saves the pending edit now (before a change in words or a build) and resolves once every save has answered.
	flush(): Promise<void>
	// The boards and cables a change added or changed blink twice.
	flash(names: Set<string>): void
	dispose(): void
	readonly plan: Plan
}
export const esc: (s: unknown) => string
export function addStyle(key: string, css: string): void
export function mountPlanCanvas(
	host: HTMLElement,
	opts: {
		id: string
		view: PlanView
		// After each edit on the drawing, with the edited plan (before it is saved).
		onChange?: (plan: Plan) => void
		// Each view the drawing took from the hub on its own: a save's answer, or a reload after a stale save.
		onView?: (v: PlanView) => void
		// A line for the user (a stale save, a failed one).
		onMsg?: (text: string, err?: boolean) => void
	},
): PlanCanvas
