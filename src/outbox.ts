import { appendFileSync } from "node:fs"
import type { SemanticEvent } from "@mozaik-ai/core"

type Send = (event: SemanticEvent, senderId: string) => void

// Mozaik 4.1's publish is synchronous and re-entrant (issue #115): an event sent from inside a handler
// is delivered before the current event reaches the remaining participants. The outbox queues such
// sends and delivers one event at a time, so every participant sees the same order. It also writes
// each event to the run trace.
export class Outbox {
	private queue: { event: SemanticEvent; senderId: string }[] = []
	private draining = false
	private seq = 0

	constructor(
		private readonly send: Send,
		private readonly tracePath: string | null,
	) {}

	emit(event: SemanticEvent, senderId: string): void {
		this.queue.push({ event, senderId })
		if (this.draining) {
			return
		}
		this.draining = true
		try {
			while (this.queue.length > 0) {
				const next = this.queue.shift()!
				this.trace(next.event)
				try {
					this.send(next.event, next.senderId)
				} catch (error) {
					console.error(`[outbox] handler failed on ${next.event.type}:`, error)
				}
			}
		} finally {
			this.draining = false
		}
	}

	private trace(event: SemanticEvent): void {
		const line = { seq: this.seq++, at: event.occurredAt.toISOString(), type: event.type, producerId: event.producerId, payload: event.payload }
		if (this.tracePath) {
			appendFileSync(this.tracePath, JSON.stringify(line) + "\n")
		}
	}
}
