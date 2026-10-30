import { randomUUID } from "node:crypto"
import { OWNERS, type AgentRole, type FieldName } from "./contract/types.ts"

export interface Decision {
	approved: boolean
	reason: string
	by: AgentRole
}

interface Entry {
	field: FieldName
	requester: AgentRole
	decision?: Decision
	waiters: ((d: Decision) => void)[]
}

// Open change requests waiting for the owner of a contract field to decide.
export class ApprovalRegistry {
	private entries = new Map<string, Entry>()

	open(field: FieldName, requester: AgentRole): string {
		const id = randomUUID().slice(0, 8)
		this.entries.set(id, { field, requester, waiters: [] })
		return id
	}

	wait(id: string, timeoutMs: number): Promise<Decision> {
		const entry = this.entries.get(id)
		if (!entry) return Promise.resolve({ approved: false, reason: "unknown proposal", by: "consistency" })
		if (entry.decision) return Promise.resolve(entry.decision)
		return new Promise((resolve) => {
			const timer = setTimeout(() => this.resolve(id, { approved: false, reason: "timeout", by: OWNERS[entry.field] }), timeoutMs)
			entry.waiters.push((d) => {
				clearTimeout(timer)
				resolve(d)
			})
		})
	}

	// Only the owner of the field may decide; other decisions and repeats are ignored.
	resolve(id: string, decision: Decision): boolean {
		const entry = this.entries.get(id)
		if (!entry || entry.decision) return false
		if (decision.reason !== "timeout" && decision.by !== OWNERS[entry.field]) return false
		entry.decision = decision
		for (const w of entry.waiters.splice(0)) w(decision)
		return true
	}

	// The owner who approved this proposal for this field and requester, if any.
	approverOf(id: string, field: FieldName, requester: AgentRole): AgentRole | undefined {
		const entry = this.entries.get(id)
		if (!entry?.decision?.approved || entry.field !== field || entry.requester !== requester) return undefined
		return entry.decision.by
	}

	// Change requests still waiting for a decision.
	openCount(): number {
		return [...this.entries.values()].filter((e) => !e.decision).length
	}

	fieldOf(id: string): FieldName | undefined {
		return this.entries.get(id)?.field
	}
}
