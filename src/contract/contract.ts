import { isDeepStrictEqual } from "node:util"
import { FIELDS, OWNERS, PART_ROLES, SIGNAL_PATTERN, type ContractSnapshot, type ContractValues, type FieldName, type Proposal, type ProposalResult } from "./types.ts"

// Single source of truth for the design. Each field has one owning role and a version;
// a write must name the version it was based on, so concurrent writers can't silently overwrite each other.
export class DesignContract {
	private values: Partial<ContractValues> = {}
	private versions = Object.fromEntries(FIELDS.map((f) => [f, 0])) as Record<FieldName, number>
	private rev = 0
	private catalog: { role: string; mpn: string; lcsc: string | null }[] | null = null
	// Every revision as it was applied, so diffs between revisions can be shown after the fact.
	private history: ContractSnapshot[] = []

	// With a catalog set, every part must be a catalog part (matched by MPN, case-insensitive), so a model
	// can't keep proposing parts nobody vetted; the refusal lists the catalog's options for that role.
	setCatalog(catalog: { role: string; mpn: string; lcsc: string | null }[]): void {
		this.catalog = catalog
	}

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

	snapshotAt(revision: number): ContractSnapshot | undefined {
		const s = this.history[revision - 1]
		return s === undefined ? undefined : structuredClone(s)
	}

	snapshot(): ContractSnapshot {
		return structuredClone({ revision: this.rev, values: this.values, versions: this.versions })
	}

	// Every check on the value itself: its shape, the bench's scope, catalog-only parts, and pins that name the
	// peripheral (not the MCU) with valid signal names. propose refuses what this refuses; change control calls it
	// before holding a change, so an owner is never asked to approve a value the contract would refuse.
	validate<F extends FieldName>(p: Pick<Proposal<F>, "field" | "value" | "by">): string | null {
		const shape = shapeError(p.field, p.value)
		if (shape) return shape
		if (p.by === "bench") {
			const scope = benchScopeError(p.field, this.values.rails, p.value)
			if (scope) return scope
		}
		if (p.field === "parts" && this.catalog) {
			const known = new Set(this.catalog.map((c) => c.mpn.toLowerCase()))
			const unknown = (p.value as ContractValues["parts"]).filter((part) => !known.has(part.mpn.toLowerCase()))
			if (unknown.length > 0) {
				const options = (role: string) =>
					this.catalog!.filter((c) => c.role === role).map((c) => `${c.mpn} (${c.lcsc ?? "no LCSC"})`).join(", ") || "none in the catalog"
				return `only catalog parts are allowed: ${unknown.map((u) => `${u.ref} ${u.mpn} is not in the catalog; options for role ${u.role}: ${options(u.role)}`).join("; ")}`
			}
		}
		if (p.field === "pins") {
			const mcus = new Set((this.values.parts ?? []).filter((part) => part.role === "mcu").map((part) => part.ref))
			const onMcu = (p.value as ContractValues["pins"]).filter((pin) => mcus.has(pin.partRef))
			if (onMcu.length > 0) {
				return `partRef must be the part the GPIO connects to, not the MCU: ${onMcu.map((pin) => `${pin.signal} → ${pin.partRef}`).join(", ")}. Add the peripheral part first if it is missing.`
			}
			const bad = (p.value as ContractValues["pins"]).filter((pin) => !SIGNAL_PATTERN.test(pin.signal)).map((pin) => pin.signal)
			if (bad.length > 0) return `signal names must match ${SIGNAL_PATTERN}: ${bad.join(", ")}`
		}
		return null
	}

	propose<F extends FieldName>(p: Proposal<F>): ProposalResult {
		const owner = OWNERS[p.field]
		if (p.by !== owner && p.approvedBy !== owner) {
			return { status: "not-owner", owner }
		}
		const invalid = this.validate(p)
		if (invalid) return { status: "invalid", reason: invalid }
		if (isDeepStrictEqual(this.values[p.field], p.value)) {
			return { status: "unchanged", version: this.versions[p.field] }
		}
		if (p.baseVersion !== this.versions[p.field]) {
			return { status: "stale", current: this.versions[p.field] }
		}
		this.values[p.field] = structuredClone(p.value)
		this.versions[p.field]++
		this.rev++
		this.history.push(structuredClone({ revision: this.rev, values: this.values, versions: this.versions }))
		return { status: "applied", version: this.versions[p.field], revision: this.rev }
	}
}

const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v)
const isStr = (v: unknown) => typeof v === "string"
const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

// The keys of a rail the bench may write: what it measured, and where the number came from.
const BENCH_RAIL_KEYS = new Set(["averageMa", "averageSource", "measuredRevision"])

// The bench proposes through change control like anyone else, but even an approved bench proposal may only
// write a measurement onto one existing rail: same rails, same order, nothing else changed.
function benchScopeError(field: FieldName, current: ContractValues["rails"] | undefined, value: unknown): string | null {
	if (field !== "rails") return `the bench may only change rails, not ${field}`
	const next = value as ContractValues["rails"]
	if (!current || current.length !== next.length) return "the bench may not add or remove rails"
	const without = (r: object) => Object.fromEntries(Object.entries(r).filter(([k]) => !BENCH_RAIL_KEYS.has(k)))
	const touched = next.filter((r, i) => !isDeepStrictEqual(without(r), without(current[i]))).map((r) => r.name)
	if (touched.length) return `the bench may only change averageMa, averageSource and measuredRevision; it changed other keys of ${touched.join(", ")}`
	const measured = next.filter((r, i) => !isDeepStrictEqual(r, current[i])).map((r) => r.name)
	return measured.length > 1 ? `the bench measures one rail at a time; it changed ${measured.join(", ")}` : null
}

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
			if (bad.length) return `rail averageMa must be a number from 0 to the rail's loadMa (the peak); got ${bad.map((r) => `${r.name}: ${JSON.stringify(r.averageMa)}`).join(", ")}`
			const source = (value as Record<string, unknown>[]).filter(
				(r) => (r.averageSource !== undefined && r.averageSource !== "estimated" && r.averageSource !== "measured") || (r.measuredRevision !== undefined && !(Number.isInteger(r.measuredRevision) && (r.measuredRevision as number) >= 0)),
			)
			return source.length ? `rail averageSource must be "estimated" or "measured", and measuredRevision a revision number; got ${source.map((r) => r.name).join(", ")}` : null
		}
		case "parts": {
			const shape = list((x) => isStr(x.ref) && isStr(x.role) && isStr(x.mpn) && Array.isArray(x.pins), "{ref, role, mpn, lcsc, footprint, pins[]}")
			if (shape) return shape
			const bad = (value as { ref: string; role: string }[]).filter((p) => !(PART_ROLES as readonly string[]).includes(p.role))
			return bad.length ? `part role must be one of ${PART_ROLES.join(", ")}; got ${bad.map((p) => `${p.ref}: "${p.role}"`).join(", ")}` : null
		}
		case "pins":
			return list((x) => isStr(x.signal) && isNum(x.gpio) && isStr(x.partRef) && isStr(x.partPin), "{signal, gpio, partRef, partPin}")
		case "behavior": {
			const ok = obj(value) && isNum(value.blinkMs) && isNum(value.tiltBlinkMs) && isNum(value.tiltDeg)
			return ok && (value.blinkMs as number) > 0 && (value.tiltBlinkMs as number) > 0 && (value.tiltDeg as number) >= 0 && (value.tiltDeg as number) <= 90
				? null
				: "behavior must be {blinkMs > 0, tiltBlinkMs > 0, tiltDeg from 0 to 90}"
		}
	}
}
