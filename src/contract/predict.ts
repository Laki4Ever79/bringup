import { checkConsistency, type Violation } from "./consistency.ts"
import type { ContractSnapshot, FieldName } from "./types.ts"

// What a proposed change would raise, by the quick checks (no artifacts): the violations of the proposed contract
// that the current one doesn't have. Change control shows them to the owner deciding, and refuses in code a change
// that would raise one in the owner's own care: in real rover run 10 (15 Nov) owners approved changes that undid their
// own fixes (the architect removing the parts agent's sensor connector and button, the firmware engineer adding pins
// on parts that didn't exist), and the run spent its 40 revisions putting them back.
export function predictedViolations(s: ContractSnapshot, field: FieldName, value: unknown, brief: string): Violation[] {
	const key = (v: Violation) => `${v.kind}\u0000${v.message}`
	const before = new Set(checkConsistency(s, {}, brief, { quick: true }).map(key))
	const after = checkConsistency({ ...s, values: { ...s.values, [field]: value } } as ContractSnapshot, {}, brief, { quick: true })
	return after.filter((v) => !before.has(key(v)))
}
