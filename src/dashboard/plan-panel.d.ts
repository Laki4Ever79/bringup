import type { PlanView } from "./plans.ts"
import type { PlanCanvas } from "./plan-canvas.js"
export interface PlanPanel {
	apply(v: PlanView): void
	msg(text: string, err?: boolean): void
	// A build is already under way: Build stays off, with this line.
	building(text: string): void
	dispose(): void
}
export function mountPlanPanel(
	host: HTMLElement,
	opts: {
		id: string
		view: PlanView
		canvas?: PlanCanvas
		// The build started: the hub's answer to POST /api/plans/:id/build.
		onBuild?: (result: { systemId?: string; runId?: string }) => void
		// Every view the panel shows (the page's own lines: what was said, what planning spent).
		onView?: (v: PlanView) => void
	},
): PlanPanel
