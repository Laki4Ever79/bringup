import { isDeepStrictEqual } from "node:util"
import { FIELDS, OWNERS, PART_ROLES, SIGNAL_PATTERN, type ContractSnapshot, type ContractValues, type FieldName, type Proposal, type ProposalResult } from "./types.ts"

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
			const mcus = new Set((this.values.parts ?? []).filter((part) => part.role === "mcu").map((part) => part.ref))
			const onMcu = (p.value as ContractValues["pins"]).filter((pin) => mcus.has(pin.partRef))
			if (onMcu.length > 0) {
				return {
					status: "invalid",
					reason: `partRef must be the part the GPIO connects to, not the MCU: ${onMcu.map((pin) => `${pin.signal} → ${pin.partRef}`).join(", ")}. Add the peripheral part first if it is missing.`,
				}
			}
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
		case "requirements": {
			if (!(obj(value) && isStr(value.summary) && Array.isArray(value.peripherals))) return "requirements must be {summary, peripherals[], batteryLifeDays}"
			if (value.batteryMah !== undefined && !(isNum(value.batteryMah) && (value.batteryMah as number) > 0)) return "requirements.batteryMah must be a positive number of mAh"
			const d = value.dutyCycle
			if (d === undefined) return null
			const ok = obj(d) && isNum(d.activeMs) && isNum(d.periodS) && isNum(d.sleepUa) && (d.activeMs as number) > 0 && (d.periodS as number) > 0 && (d.sleepUa as number) >= 0
			return ok && (d.activeMs as number) <= (d.periodS as number) * 1000
				? null
				: "requirements.dutyCycle must be {activeMs > 0, periodS > 0, sleepUa >= 0} with activeMs no longer than the period"
		}
		case "outline":
			return obj(value) && isNum(value.widthMm) && isNum(value.heightMm) && isNum(value.thicknessMm) ? null : "outline must be {widthMm, heightMm, thicknessMm} numbers"
		case "connectors":
			return list((x) => isStr(x.ref) && isStr(x.edge) && isNum(x.offsetMm) && isNum(x.widthMm) && isNum(x.heightMm), "{ref, kind, edge, offsetMm, widthMm, heightMm}")
		case "rails": {
			const shape = list((x) => isStr(x.name) && isNum(x.voltageV) && isNum(x.regulatorMaxMa) && isNum(x.loadMa), "{name, voltageV, regulatorMaxMa, loadMa, averageMa?}")
			if (shape) return shape
			const bad = (value as Record<string, unknown>[]).filter((r) => r.averageMa !== undefined && !(isNum(r.averageMa) && (r.averageMa as number) >= 0 && (r.averageMa as number) <= (r.loadMa as number)))
			return bad.length ? `rail averageMa must be a number from 0 to the rail's loadMa (the peak); got ${bad.map((r) => `${r.name}: ${JSON.stringify(r.averageMa)}`).join(", ")}` : null
		}
		case "parts": {
			const shape = list((x) => isStr(x.ref) && isStr(x.role) && isStr(x.mpn) && Array.isArray(x.pins), "{ref, role, mpn, lcsc, footprint, pins[]}")
			if (shape) return shape
			const bad = (value as { ref: string; role: string }[]).filter((p) => !(PART_ROLES as readonly string[]).includes(p.role))
			return bad.length ? `part role must be one of ${PART_ROLES.join(", ")}; got ${bad.map((p) => `${p.ref}: "${p.role}"`).join(", ")}` : null
		}
		case "pins":
			return list((x) => isStr(x.signal) && isNum(x.gpio) && isStr(x.partRef) && isStr(x.partPin), "{signal, gpio, partRef, partPin}")
	}
}
