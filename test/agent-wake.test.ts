// Every check's violations reach an agent that can fix them (src/agents/recipients.ts, 26 Nov 2026): agents wake on the
// violations addressed to them, not on a kind's name, so a new domain's checks need no edit to be heard.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { recipients, routeWaiting, VIOLATION_ROLES } from "../src/agents/recipients.ts"
import { FIELDS, OWNERS, type AgentRole, type FieldName } from "../src/contract/types.ts"

const ROOT = join(import.meta.dirname, "..")

test("recipients: the agents a violation affects, and only those", () => {
	// The mechanics agent hears every domain's checks addressed to it (it heard only mech-* before).
	for (const kind of ["mech-torque", "arm-torque", "cnc-fit", "ros-package"]) assert.deepEqual(recipients({ affects: ["mechanics"], fields: ["mechanics"] }), ["mechanics"], kind)
	// A built artifact behind the contract (affects [] or a builder): nobody, the rebuild clears it. A fallback to the
	// fields' owners spent 4 turns of a settled rover mock on exactly these (9 → 13 turns, 26 Nov 2026).
	assert.deepEqual(recipients({ affects: [], fields: ["pins"] }), [])
	assert.deepEqual(recipients({ affects: ["board"], fields: ["parts"] }), [])
	assert.deepEqual(recipients({ affects: ["mechanics", "architect"], fields: ["arm", "armTargets"] }), ["mechanics", "architect"])
})

// Every `affects: […]` a check writes in src, with the `fields: […]` and kind just before it (in the same literal or the
// helper's call): what each check says about who must fix it.
function checkLiterals(): { file: string; kind: string; affects: AgentRole[]; fields: FieldName[] | null }[] {
	const out: { file: string; kind: string; affects: AgentRole[]; fields: FieldName[] | null }[] = []
	const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith(".ts") ? [join(d, f)] : []))
	const list = (s: string) => [...s.matchAll(/"([a-zA-Z]+)"/g)].map((x) => x[1])
	for (const file of walk(join(ROOT, "src"))) {
		const text = readFileSync(file, "utf8")
		for (const m of text.matchAll(/affects: \[([^\]]*)\]/g)) {
			if (!/"/.test(m[1])) continue // a computed list (a parameter), checked where it's built
			const before = text.slice(Math.max(0, m.index! - 900), m.index!)
			const f = [...before.matchAll(/fields: \[([^\]]*)\]/g)].at(-1)
			const k = [...before.matchAll(/kind: "([a-z0-9-]+)"|push\("([a-z0-9-]+)"/g)].at(-1)
			out.push({ file: file.slice(ROOT.length + 1), kind: k ? (k[1] ?? k[2]) : "?", affects: list(m[1]) as AgentRole[], fields: f && /"/.test(f[1]) ? (list(f[1]) as FieldName[]) : null })
		}
	}
	return out
}

test("every check in src reaches at least one agent that can fix it", () => {
	const checks = checkLiterals()
	assert.ok(checks.length > 100, `found ${checks.length} checks: the scan reads the literals`)
	const lost = checks.filter((c) => recipients({ affects: c.affects, fields: c.fields ?? [] }).length === 0)
	// The named exceptions, each answered elsewhere: the board builder's mismatches (the built board against a contract
	// that moved on: the rebuild clears them), and a board's links, the system's (the integrator's), fixed before any
	// board runs, whose spec check (specErrors) refuses the same over-budget links first (test/link-kinds.test.ts).
	assert.deepEqual(lost.map((c) => `${c.file}: ${c.kind} → ${c.affects.join(", ")}`).sort(), ["src/contract/consistency.ts: outline-mismatch → board", "src/contract/consistency.ts: part-mismatch → board", "src/contract/links.ts: link-budget → integrator"])
	// The domains with their own prefixes reach the mechanics agent.
	for (const prefix of ["mech-", "arm-", "cnc-"]) {
		const mine = checks.filter((c) => c.kind.startsWith(prefix) && c.affects.includes("mechanics"))
		if (mine.length) assert.ok(mine.every((c) => recipients({ affects: c.affects, fields: c.fields ?? [] }).includes("mechanics")), prefix)
	}
})

test("every role that takes violations has a handler, and every field's owner is one of them or the system's integrator", () => {
	const roles = readFileSync(join(ROOT, "src/agents/roles.ts"), "utf8")
	for (const r of VIOLATION_ROLES) assert.ok(roles.includes(`violationsFor("${r}"`) || roles.includes(`recipients(v).includes("${r}")`), `${r} has no violation handler in roles.ts`)
	// No handler filters by kind any more (the mech-* filter dropped the arm's, the CNC's and ros-package).
	assert.doesNotMatch(roles, /violationsFor\([^)]*\(kind\)/)
	const unowned = FIELDS.filter((f) => !VIOLATION_ROLES.includes(OWNERS[f]))
	assert.deepEqual(unowned.map((f) => `${f}: ${OWNERS[f]}`), ["links: integrator", "assembly: integrator"].filter((x) => unowned.includes(x.split(":")[0] as FieldName)))
})

test("a disagreement that waits on a rebuild goes to an owner once that artifact is current, never stays with nobody", () => {
	const pin = { kind: "pin-mismatch", message: "firmware drives STATUS_LED on ?, contract says GPIO21", fields: ["pins"] as FieldName[], affects: [] as AgentRole[], waitsOn: "firmware" }
	// The firmware behind the contract: it waits, nobody woken (the rebuild fixes it).
	assert.deepEqual(routeWaiting([pin], () => false)[0].affects, [])
	// Built for this revision and still wrong (the arm mock of 26 Nov 2026): the firmware agent hears it, told it's no rebuild's.
	const [now] = routeWaiting([pin], () => true)
	assert.deepEqual(now.affects, ["firmware"])
	assert.match(now.message, /the firmware built for this revision still disagrees: not a rebuild's to fix/)
	// The board has no agent: a current board's part-mismatch goes to the parts list's owner.
	assert.deepEqual(routeWaiting([{ kind: "part-mismatch", message: "board has no U6", fields: ["parts"] as FieldName[], affects: ["board"] as AgentRole[], waitsOn: "board" }], () => true)[0].affects, ["parts"])
	// One already addressed to an agent is left as it is.
	const own = { kind: "x", message: "m", fields: ["pins"] as FieldName[], affects: ["architect"] as AgentRole[], waitsOn: "firmware" }
	assert.equal(routeWaiting([own], () => true)[0], own)
})

test("every check src addresses to no agent names the artifact it waits on (or is the system's link-budget)", () => {
	const src = (f: string) => readFileSync(join(ROOT, f), "utf8")
	const text = src("src/contract/consistency.ts")
	for (const kind of ["pin-mismatch", "sensor-mismatch", "outline-mismatch", "part-mismatch", "net-missing"]) {
		const at = text.indexOf(`kind: "${kind}"`)
		assert.ok(at >= 0, kind)
		assert.match(text.slice(at, at + 600), /waitsOn: "(board|firmware|chassis|enclosure)"/, `${kind} names what it waits on`)
	}
})

