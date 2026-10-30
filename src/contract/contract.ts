import { FIELDS, OWNERS, type ContractSnapshot, type ContractValues, type FieldName, type Proposal, type ProposalResult } from "./types.ts"

// Single source of truth for the design. Each field has one owning role and a version;
// a write must name the version it was based on, so concurrent writers can't silently overwrite each other.
export class DesignContract {
	private values: Partial<ContractValues> = {}
	private versions = Object.fromEntries(FIELDS.map((f) => [f, 0])) as Record<FieldName, number>
	private rev = 0

	get revision(): number {
		return this.rev
	}

	get<F extends FieldName>(field: F): ContractValues[F] | undefined {
		const value = this.values[field]
		return value === undefined ? undefined : structuredClone(value)
	}

	version(field: FieldName): number {
		return this.versions[field]
	}

	snapshot(): ContractSnapshot {
		return structuredClone({ revision: this.rev, values: this.values, versions: this.versions })
	}

	propose<F extends FieldName>(p: Proposal<F>): ProposalResult {
		const owner = OWNERS[p.field]
		if (p.by !== owner && p.approvedBy !== owner) {
			return { status: "not-owner", owner }
		}
		if (p.baseVersion !== this.versions[p.field]) {
			return { status: "stale", current: this.versions[p.field] }
		}
		this.values[p.field] = structuredClone(p.value)
		this.versions[p.field]++
		this.rev++
		return { status: "applied", version: this.versions[p.field], revision: this.rev }
	}
}
