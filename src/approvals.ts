import { randomUUID } from "node:crypto"
import { OWNERS, type AgentRole, type FieldName } from "./contract/types.ts"

export interface Decision {
	approved: boolean
	reason: string
	by: AgentRole
	// Everyone whose vote decided it (the owner, and the engineer when engineer approval is on).
	decidedBy?: AgentRole[]
}

interface Entry {
	field: FieldName
	requester: AgentRole
	// The proposed value (JSON); an approval covers this value only.
	valueKey?: string
	// With engineer approval on, an approval needs the owner AND the engineer; a reject from either decides.
	needsEngineer: boolean
	votes: Decision[]
	decision?: Decision
	waiters: ((d: Decision) => void)[]
}

// Open change requests waiting for the owner of a contract field to decide.
export class ApprovalRegistry {
	private entries = new Map<string, Entry>()

	open(field: FieldName, requester: AgentRole, valueKey?: string, needsEngineer = false): string {
		const id = randomUUID().slice(0, 8)
		this.entries.set(id, { field, requester, valueKey, needsEngineer, votes: [], waiters: [] })
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

	// Records one vote. Only the field's owner votes (plus the engineer when engineer approval is on);
	// repeats and other voters are ignored. Returns whether the vote counted.
	resolve(id: string, vote: Decision): boolean {
		const entry = this.entries.get(id)
		if (!entry || entry.decision) return false
		if (vote.reason === "timeout") return this.finish(entry, { ...vote, approved: false, decidedBy: entry.votes.map((v) => v.by) })
		const voter = vote.by === "engineer" ? (entry.needsEngineer ? "engineer" : null) : vote.by === OWNERS[entry.field] ? "owner" : null
		if (!voter || entry.votes.some((v) => v.by === vote.by)) return false
		entry.votes.push(vote)
		const decidedBy = entry.votes.map((v) => v.by)
		if (!vote.approved) return this.finish(entry, { ...vote, decidedBy })
		const ownerOk = entry.votes.some((v) => v.by === OWNERS[entry.field] && v.approved)
		const engineerOk = !entry.needsEngineer || entry.votes.some((v) => v.by === "engineer" && v.approved)
		if (ownerOk && engineerOk) {
			const owner = entry.votes.find((v) => v.by === OWNERS[entry.field])!
			return this.finish(entry, { approved: true, by: owner.by, reason: entry.votes.map((v) => v.reason).join("; "), decidedBy })
		}
		return true
	}

	private finish(entry: Entry, decision: Decision): boolean {
		entry.decision = decision
		for (const w of entry.waiters.splice(0)) w(decision)
		return true
	}

	hasVoted(id: string, by: AgentRole): boolean {
		return this.entries.get(id)?.votes.some((v) => v.by === by) ?? false
	}

	// The owner who approved this proposal for this field and requester, if any.
	approverOf(id: string, field: FieldName, requester: AgentRole, valueKey?: string): AgentRole | undefined {
		const entry = this.entries.get(id)
		if (!entry?.decision?.approved || entry.field !== field || entry.requester !== requester) return undefined
		if (entry.valueKey !== undefined && entry.valueKey !== valueKey) return undefined
		return entry.decision.by
	}

	decisionOf(id: string): Decision | undefined {
		return this.entries.get(id)?.decision
	}

	// Change requests still waiting for a decision.
	openCount(): number {
		return [...this.entries.values()].filter((e) => !e.decision).length
	}

	fieldOf(id: string): FieldName | undefined {
		return this.entries.get(id)?.field
	}
}
