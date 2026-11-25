import { ModelMessageItem, type ExecutableTransition, type InterceptionHandler } from "@mozaik-ai/core"
import type { Steering } from "./steer.ts"

export const STOPPED_ANSWER = "Stopped by the engineer."

// The steering gate around an agent's own interception handler (change control). Mozaik's loop asks the interception
// handler before every transition (message_received, inference, function_call, model_message), so this is where a
// loop waits while its agent or the run is paused, and ends when its agent was stopped (or redone) after it started.
// Stopping rewrites the next transition into a model_message: the loop publishes model.answer and goes idle by itself,
// so the turn trackers see an ordinary end. It never returns "idle" (Mozaik 4.1 issue #113 crashes on that).
export class SteerGate implements InterceptionHandler {
	private readonly epoch: number

	constructor(
		private readonly steer: Steering,
		private readonly name: string,
		private readonly inner?: InterceptionHandler,
		// The step this loop is, noted once it really starts (past any pause), so Redo reruns what last ran.
		private readonly step?: { summary: string; redo: () => void },
	) {
		this.epoch = steer.epochOf(name)
	}

	private started = false
	private start(): void {
		if (this.started) return
		this.started = true
		if (this.step) this.steer.noteStep(this.name, this.step.summary, this.step.redo)
	}

	private stale(): boolean {
		return this.steer.epochOf(this.name) !== this.epoch
	}

	isSatisfiedBy(transition: ExecutableTransition): boolean {
		// The loop's own answer always goes through: ending is never held.
		if (transition.nextStateId === "model_message") return this.inner?.isSatisfiedBy(transition) ?? false
		if (this.stale() || this.steer.held(this.name)) {
			// For the activity lanes (agents/activity.ts): this hold is the engineer's pause, not change control.
			;(transition as { steerHold?: string }).steerHold = this.stale() ? "stopped" : "paused"
			return true
		}
		this.start()
		return this.inner?.isSatisfiedBy(transition) ?? false
	}

	async handle(transition: ExecutableTransition): Promise<ExecutableTransition> {
		if (transition.nextStateId !== "model_message") {
			await this.steer.gate(this.name, () => this.stale())
			if (this.stale()) return { nextStateId: "model_message", input: { answer: ModelMessageItem.rehydrate({ text: STOPPED_ANSWER }) } } as ExecutableTransition
			this.start()
		}
		return this.inner?.isSatisfiedBy(transition) ? this.inner.handle(transition) : transition
	}
}
