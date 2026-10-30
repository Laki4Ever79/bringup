import { isDeepStrictEqual } from "node:util"
import { FIELDS, OWNERS, SIGNAL_PATTERN, type ContractSnapshot, type ContractValues, type FieldName, type Proposal, type ProposalResult } from "./types.ts"

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
		const shape = shapeError(p.field, p.value)
		if (shape) return { status: "invalid", reason: shape }
		if (p.field === "pins") {
			const bad = (p.value as ContractValues["pins"]).filter((pin) => !SIGNAL_PATTERN.test(pin.signal)).map((pin) => pin.signal)
			if (bad.length > 0) return { status: "invalid", reason: `signal names must match ${SIGNAL_PATTERN}: ${bad.join(", ")}` }
		}
		if (isDeepStrictEqual(this.values[p.field], p.value)) {
			return { status: "unchanged", version: this.versions[p.field] }
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

const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v)
const isStr = (v: unknown) => typeof v === "string"
const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

// Rejects values a model got structurally wrong, so a bad shape never reaches the checkers and builders.
function shapeError(field: FieldName, value: unknown): string | null {
	const list = (check: (x: Record<string, unknown>) => boolean, what: string) =>
		Array.isArray(value) && value.every((x) => obj(x) && check(x)) ? null : `${field} must be an array of ${what}`
	switch (field) {
		case "requirements":
			return obj(value) && isStr(value.summary) && Array.isArray(value.peripherals) ? null : "requirements must be {summary, peripherals[], batteryLifeDays}"
		case "outline":
			return obj(value) && isNum(value.widthMm) && isNum(value.heightMm) && isNum(value.thicknessMm) ? null : "outline must be {widthMm, heightMm, thicknessMm} numbers"
		case "connectors":
			return list((x) => isStr(x.ref) && isStr(x.edge) && isNum(x.offsetMm) && isNum(x.widthMm) && isNum(x.heightMm), "{ref, kind, edge, offsetMm, widthMm, heightMm}")
		case "rails":
			return list((x) => isStr(x.name) && isNum(x.voltageV) && isNum(x.regulatorMaxMa) && isNum(x.loadMa), "{name, voltageV, regulatorMaxMa, loadMa}")
		case "parts":
			return list((x) => isStr(x.ref) && isStr(x.role) && isStr(x.mpn) && Array.isArray(x.pins), "{ref, role, mpn, lcsc, footprint, pins[]}")
		case "pins":
			return list((x) => isStr(x.signal) && isNum(x.gpio) && isStr(x.partRef) && isStr(x.partPin), "{signal, gpio, partRef, partPin}")
	}
}
