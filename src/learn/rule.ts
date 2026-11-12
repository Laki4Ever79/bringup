import { FORMULAS } from "./formulas.ts"
import { criticalFields, type KindFile } from "./kinds.ts"
import type { Fact } from "./types.ts"

// The facts found, completed by the kind: calculated values whose inputs were all found, the kind's stated defaults
// for missing non-critical fields (red on the card, listed in the report), and every fact marked critical or not.
// A missing critical field is never filled in.
export function completeFacts(found: Fact[], kind: KindFile): Fact[] {
	const critical = new Set(criticalFields(kind))
	const out = found.map((f) => ({ ...f, critical: critical.has(f.field) }))
	const has = (field: string) => out.some((f) => f.field === field)
	for (const [field, c] of Object.entries(kind.calculated)) {
		if (has(field)) continue
		const formula = FORMULAS[c.formula]
		const inputs = c.inputs.map((i) => out.find((f) => f.field === i)?.value)
		if (!formula || !inputs.every((v) => typeof v === "number")) continue
		const value = formula.fn(Object.fromEntries(c.inputs.map((i, k) => [i, inputs[k] as number])))
		if (!Number.isFinite(value)) continue
		out.push({ field, value: Number(value.toPrecision(4)), unit: formula.unit, status: "calculated", critical: critical.has(field), formula: formula.text, inputs: c.inputs })
	}
	for (const [field, d] of Object.entries(kind.defaults)) {
		if (has(field) || critical.has(field)) continue
		out.push({ field, value: d.value, unit: kind.fields.find((f) => f.field === field)?.unit, status: "default", critical: false, reason: d.reason })
	}
	return out
}

export type Judgement = { ok: true; reds: Fact[]; unknown: string[] } | { ok: false; missingCritical: string[] }

// Is the part usable? Not when a critical fact is missing (the learner then tries other sources, then the next
// candidate part). Otherwise yes, with its defaults (reds) and the non-critical fields nothing gave (unknown).
export function judge(facts: Fact[], kind: KindFile): Judgement {
	const has = new Set(facts.map((f) => f.field))
	const missingCritical = criticalFields(kind).filter((f) => !has.has(f))
	if (missingCritical.length) return { ok: false, missingCritical }
	const fields = [...kind.fields.map((f) => f.field), ...Object.keys(kind.calculated)]
	return { ok: true, reds: facts.filter((f) => f.status === "default"), unknown: fields.filter((f) => !has.has(f)) }
}
