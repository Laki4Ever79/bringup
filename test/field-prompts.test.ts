// Every contract field the code checks reaches its owner's prompt (26 Nov 2026: mechanics.drive.turnScale and
// maxAccelMps2 were checked in src/mechanics/shape.ts but missing from MECHANICS_SHAPE, the text the mechanics engineer
// is given, so a change request naming them had nothing to land on). For each field: the keys its shape check reads
// (src/contract/contract.ts shapeError, and the field's own *Error functions it hands over to) must each appear in the
// prompt of the agent that owns the field (OWNERS), as src/agents/roles.ts builds it.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import * as roles from "../src/agents/roles.ts"
import { MECHANICS_SHAPE } from "../src/mechanics/shape.ts"
import { ARM_SHAPE, ARM_TARGETS_SHAPE } from "../src/arm/shape.ts"
import { CNC_SHAPE, CNC_TARGETS_SHAPE } from "../src/cnc/shape.ts"
import { OWNERS, type FieldName } from "../src/contract/types.ts"

const SRC = resolve(import.meta.dirname, "../src")
const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : f.endsWith(".ts") ? [join(d, f)] : []))
const sources = files(SRC).map((f) => readFileSync(f, "utf8"))

// A function's body, by name, from wherever it is defined in src.
function body(name: string): string {
	for (const s of sources) {
		const i = s.indexOf(`export function ${name}(`)
		if (i < 0) continue
		const end = s.indexOf("\n}\n", i)
		return s.slice(i, end < 0 ? undefined : end)
	}
	return ""
}

// The shape check of each field: its case in shapeError, plus every *Error function that case hands over to.
function checkSource(field: string): string {
	const s = readFileSync(join(SRC, "contract/contract.ts"), "utf8")
	const fn = s.slice(s.indexOf("function shapeError("))
	const at = fn.indexOf(`case "${field}"`)
	if (at < 0) return ""
	const next = fn.slice(at + 1).search(/\n\t\tcase "/)
	let chunk = fn.slice(at, next < 0 ? undefined : at + 1 + next)
	const seen = new Set<string>()
	for (let more = true; more; ) {
		more = false
		for (const m of [...chunk.matchAll(/\b(\w+Error)\(/g)]) if (!seen.has(m[1]) && m[1] !== "shapeError") { seen.add(m[1]); chunk += body(m[1]); more = true }
	}
	return chunk
}

// What the code reads: properties of the value under check (value, v, and the short names the checks give its parts).
const NOT_KEYS = new Set(["length", "every", "some", "map", "filter", "includes", "find", "join", "keys", "values", "entries", "test", "startsWith", "endsWith", "toFixed", "push", "has", "get", "size", "slice", "trim", "toLowerCase", "isArray", "isInteger", "isFinite", "reduce", "indexOf", "concat", "sort", "split", "exec", "replace", "flatMap", "forEach", "add", "at"])
function keysRead(src: string): string[] {
	return [...new Set([...src.matchAll(/\b(?:value|v|x|z|d|b|c|s|k|r|p|a|m|t|e|j|w|l|o|q|g|h|f|n|u|y)\??\.([a-zA-Z]\w*)\b/g)].map((m) => m[1]))].filter((k) => !NOT_KEYS.has(k))
}

// Each role's prompt: its instruction in roles.ts with the shared texts it interpolates filled in.
const SHARED: Record<string, string> = { ...Object.fromEntries(Object.entries(roles).filter(([, v]) => typeof v === "string")), MECHANICS_SHAPE, ARM_SHAPE, ARM_TARGETS_SHAPE, CNC_SHAPE, CNC_TARGETS_SHAPE } as Record<string, string>
function prompts(): Map<string, string> {
	const s = readFileSync(join(SRC, "agents/roles.ts"), "utf8")
	const out = new Map<string, string>()
	for (const m of s.matchAll(/role: "(\w+)"/g)) {
		const i = s.indexOf("instruction:", m.index!)
		let k = s.indexOf("`", i) + 1
		const start = k
		for (let depth = 0; ; k++) {
			if (s[k] === "\\") { k++; continue }
			if (s.startsWith("${", k)) { depth++; k++; continue }
			if (s[k] === "}" && depth) { depth--; continue }
			if (s[k] === "`" && !depth) break
		}
		const raw = s.slice(start, k)
		const unresolved: string[] = []
		const text = raw.replace(/\$\{(\w+)\}/g, (_, name) => (name in SHARED ? SHARED[name] : (unresolved.push(name), "")))
		assert.deepEqual(unresolved, [], `the ${m[1]} prompt interpolates something this test can't read`)
		out.set(m[1], (out.get(m[1]) ?? "") + text)
	}
	return out
}

// Fields no agent writes: code derives them, so there is no prompt for them to reach. Each with where it comes from.
const WRITTEN_BY_CODE: Partial<Record<FieldName, string>> = {
	links: "the system layer derives each board's side of the system's links (src/system/derive.ts) and run.ts applies it as the integrator",
	assembly: "the system layer places the boards on the plate (src/system/assembly.ts) and run.ts applies it as the integrator",
}

test("each key a field's check reads is named in the prompt of the agent that owns the field", () => {
	const byRole = prompts()
	const missing: string[] = []
	for (const field of Object.keys(OWNERS) as FieldName[]) {
		if (WRITTEN_BY_CODE[field]) continue
		const owner = OWNERS[field]
		const prompt = byRole.get(owner)
		assert.ok(prompt, `no prompt found for ${owner}, owner of ${field}`)
		const src = checkSource(field)
		assert.ok(src, `no shape check found for ${field}`)
		for (const k of keysRead(src)) if (!new RegExp(`\\b${k}\\b`).test(prompt)) missing.push(`${field}.${k} (${owner})`)
	}
	assert.deepEqual(missing, [], `checked but not in the owner's prompt:\n${missing.join("\n")}`)
})
