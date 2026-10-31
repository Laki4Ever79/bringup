import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pinsHeader } from "../src/codegen/firmware.ts"
import { classifyView, VIEWS } from "../src/runner/linked.ts"
import { ROOT } from "../src/run.ts"
import { fixtureContract } from "./fixture.ts"

const pinsView = VIEWS.find((v) => v.path === "firmware/pins.h")!
const boardView = VIEWS.find((v) => v.path === "board/board.kicad_pcb")!

function revs() {
	const base = fixtureContract()
	const now = structuredClone(base)
	return { base, now }
}

test("three-way classify of a linked pins.h: untouched, re-saved, request, drift", () => {
	const { base, now } = revs()
	const b = pinsHeader(base)
	assert.deepEqual(classifyView(pinsView, b, b, base, now), { action: "untouched" })
	assert.deepEqual(classifyView(pinsView, b.replace("#pragma once", "#pragma once   ").replace(/\n/g, "\n\n"), b, base, now).action, "resaved", "whitespace only")
	const moved = classifyView(pinsView, b.replace("#define PIN_I2C_SDA 8", "#define PIN_I2C_SDA 4"), b, base, now)
	assert.deepEqual(moved, { action: "request", mapped: ["I2C_SDA GPIO8 → GPIO4"], fields: ["pins"], drift: [], movedSince: [] })
	const drift = classifyView(pinsView, b + "#define DEBUG_LOG 1\n", b, base, now)
	assert.deepEqual(drift, { action: "drift", drift: ["+ #define DEBUG_LOG 1"] })
})

test("when the design moved since the base: an edit to other fields is rebased, the same field is a conflict", () => {
	const { base, now } = revs()
	const b = pinsHeader(base)
	const edit = b.replace("#define PIN_I2C_SDA 8", "#define PIN_I2C_SDA 4")
	// behavior (a firmware input) changed since the base: the pins edit is independent of it.
	now.versions.behavior = (now.versions.behavior ?? 0) + 1
	now.revision = base.revision + 1
	assert.deepEqual(classifyView(pinsView, edit, b, base, now), { action: "rebase", mapped: ["I2C_SDA GPIO8 → GPIO4"], fields: ["pins"], drift: [], movedSince: ["behavior"] })
	// pins changed since the base too: a real clash, for the owner of pins to decide.
	now.versions.pins = (now.versions.pins ?? 0) + 1
	assert.equal(classifyView(pinsView, edit, b, base, now).action, "conflict")
})

test("a KiCad re-save that keeps the design is 'no design change'; a moved outline is a request", () => {
	const { base, now } = revs()
	base.values.outline = { widthMm: 40, heightMm: 30, thicknessMm: 1.6 }
	base.values.connectors = [{ ref: "J1", kind: "usb-c", edge: "left", offsetMm: 15, widthMm: 9, heightMm: 3.5 }]
	const pcb = readFileSync(join(ROOT, "test/data/drc-j1/board.kicad_pcb"), "utf8")
	// What KiCad does on a plain save: re-indents and re-stamps uuids.
	const resaved = pcb.replace(/\n {2}/g, "\n\t").replace(/\(uuid "?[0-9a-f-]+"?\)/g, '(uuid "00000000-0000-0000-0000-000000000000")')
	assert.notEqual(resaved, pcb)
	assert.deepEqual(classifyView(boardView, resaved, pcb, base, now), { action: "resaved" })
	const wider = pcb.replace(/\(gr_line\s+\(start ([\d.]+) /, (m) => m) // unchanged helper anchor
	assert.equal(classifyView(boardView, wider, pcb, base, now).action, "untouched")
})

import { execFileSync } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"
import { appendRequest } from "../src/runner/requests.ts"
import { linkedStatusLines } from "../src/runner/linked.ts"
import { runDesign } from "../src/run.ts"
import { detectEnvironment } from "../src/tools/env.ts"
import { tempDir, waitFor } from "./helpers.ts"

const gitLog = (dir: string) => execFileSync("git", ["-C", dir, "log", "--format=%an|%s"], { encoding: "utf8" }).trim().split("\n").filter(Boolean)
const gitDirty = (dir: string) => execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" }).trim()
const tr = (out: string) => readFileSync(join(out, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
const driftOf = (out: string) => JSON.parse(readFileSync(join(out, "drift.json"), "utf8")).entries as { kind: string; status: string; path: string; requestId?: string; note?: string; items: string[] }[]

test("a linked working copy: a commit per settled revision, an edit becomes a request, an independent edit is rebased, drift blocks regeneration", { timeout: 120_000 }, async () => {
	const out = tempDir()
	const link = join(tempDir(), "design")
	const env = await detectEnvironment(ROOT)
	let end: () => void = () => {}
	const until = new Promise<void>((r) => (end = r))
	const run = runDesign({ brief: readFileSync(join(ROOT, "briefs/logger.md"), "utf8"), mock: true, noHardware: true, outDir: out, env, stay: { until }, link })
	const pins = join(link, "firmware/pins.h")
	const settles = () => (existsSync(join(out, "trace.jsonl")) ? tr(out).filter((e) => e.type === "design.settled").length : 0)
	try {
		await waitFor(() => existsSync(pins) && gitLog(link).length === 1, 30_000)
		assert.match(gitLog(link)[0], /^Bringup\|Bringup rev \d+: the design from the brief$/)
		assert.match(execFileSync("git", ["-C", link, "log", "-1", "--format=%B"], { encoding: "utf8" }), /^Bringup-Revision: \d+$/m)
		assert.equal(gitDirty(link), "")

		// 1. An edit that maps, with the design where the base left it: a request; the next commit carries it.
		writeFileSync(pins, readFileSync(pins, "utf8").replace(/^#define PIN_I2C_SDA \d+$/m, "#define PIN_I2C_SDA 4"))
		await waitFor(() => gitLog(link).length === 2, 20_000)
		assert.match(gitLog(link)[0], /^Bringup\|Bringup rev \d+: edited pins\.h: I2C_SDA GPIO8 → GPIO4$/)
		assert.match(readFileSync(pins, "utf8"), /^#define PIN_I2C_SDA 4$/m)
		assert.equal(gitDirty(link), "", "the commit holds exactly what is on disk")
		const req = tr(out).find((e) => e.type === "change.requested")!
		assert.equal(req.payload.source.path, "firmware/pins.h")

		// 2. The design moves (a behavior change, a firmware input) and, before the next settle, the engineer moves a pin
		//    in the file they had: independent of behavior, so it is rebased onto the new revision.
		const before = settles() // the behavior change and the rebased pin move may settle as one
		appendRequest(out, "blink faster")
		await waitFor(() => tr(out).filter((e) => e.type === "contract.changed" && e.payload.field === "behavior").length > 0, 10_000)
		writeFileSync(pins, readFileSync(pins, "utf8").replace(/^#define PIN_I2C_SCL \d+$/m, "#define PIN_I2C_SCL 3"))
		await waitFor(() => driftOf(out).some((e) => e.kind === "rebased"), 10_000)
		const rebased = driftOf(out).find((e) => e.kind === "rebased")!
		assert.equal(rebased.status, "rebased")
		assert.match(rebased.note!, /behavior changed since rev \d+, independent of pins/)
		await waitFor(() => /^#define PIN_I2C_SCL 3$/m.test(execFileSync("git", ["-C", link, "show", "HEAD:firmware/pins.h"], { encoding: "utf8" })), 20_000)

		// 3. Drift (not in the contract) is never overwritten: the next regeneration skips the file and says so.
		const commits = gitLog(link).length
		writeFileSync(pins, readFileSync(pins, "utf8") + "#define DEBUG_LOG 1\n")
		await waitFor(() => driftOf(out).some((e) => e.kind === "not-in-contract" && e.status === "open"), 10_000)
		appendRequest(out, "make the board 60 mm wide")
		await waitFor(() => gitLog(link).length > commits, 20_000)
		assert.match(readFileSync(pins, "utf8"), /#define DEBUG_LOG 1/, "the user's edit is still there")
		assert.match(driftOf(out).find((e) => e.kind === "not-in-contract")!.note!, /regeneration skipped: unadopted edits/)
	} finally {
		end()
		await run
	}
	// 4. Offline, after the run: status rescans the linked folder from git and the contract files.
	const lines = linkedStatusLines(out)
	assert.match(lines[0], /^Linked folder .*design \(base [0-9a-f]{7}, rev \d+; design at rev \d+\):$/)
	assert.ok(lines.some((l) => /modified {2}firmware\/pins\.h {2}\(not in the contract\)/.test(l)), lines.join("\n"))
	assert.ok(lines.includes("              + #define DEBUG_LOG 1"))
})
