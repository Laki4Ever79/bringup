import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { appendEvidence, levelOf, loadModules, moduleStatus, modulesUsed, readEvidence, runEvidence, type Evidence } from "../src/modules/library.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import type { Artifacts } from "../src/contract/consistency.ts"

const ROOT = resolve(import.meta.dirname, "..")
const dir = () => mkdtempSync(join(tmpdir(), "bringup-modules-"))
const ev = (level: Evidence["level"], result: Evidence["result"]): Evidence => ({ at: "t", module: "m", level, result, by: "build" })

test("every module in catalog/modules is cited: each part is in a catalog and every bought number has a source", () => {
	const status = moduleStatus(ROOT, dir())
	assert.ok(status.length >= 5)
	for (const s of status) assert.deepEqual(s.problems, [], s.module.id)
	assert.ok(status.every((s) => s.level === "cited"))
})

test("the scripted rover uses the motor stage, the power, the distance sensor and the SHT40 modules", () => {
	const used = modulesUsed(loadModules(ROOT), ROVER_BOARD).map((m) => m.id).sort()
	assert.deepEqual(used, ["climate-sht40", "distance-vl53l0x", "motor-stage-drv8833", "power-1s-tp4054"])
})

test("a run's artifacts become evidence: built, tested (drivers), simulated; a failed drive is a fail for each module", () => {
	const used = modulesUsed(loadModules(ROOT), ROVER_BOARD)
	const a = {
		board: { drc: { errors: 0, unconnected: 0 } },
		firmware: { ok: true, driverTests: { ok: true, drivers: ["drv8833", "vl53l0x", "sensirion"], passed: 9, failed: [] } },
		drive: { result: "fail", reason: "edge crossed: the caster stalled", segments: [] },
	} as unknown as Artifacts
	const e = runEvidence(used, a, "r1", 11)
	const motor = e.filter((x) => x.module === "motor-stage-drv8833")
	assert.deepEqual(motor.map((x) => [x.level, x.result]), [["built", "pass"], ["tested", "pass"], ["simulated", "fail"]])
	// The power module has no driver: no host-test evidence for it.
	assert.ok(!e.some((x) => x.module === "power-1s-tp4054" && x.level === "tested"))
})

test("the level is the highest one whose latest evidence passes; a later fail drops it", () => {
	assert.equal(levelOf([], true), "cited")
	assert.equal(levelOf([], false), null)
	assert.equal(levelOf([ev("built", "pass"), ev("simulated", "pass")], true), "simulated")
	assert.equal(levelOf([ev("built", "pass"), ev("simulated", "pass"), ev("simulated", "fail")], true), "built")
	assert.equal(levelOf([ev("built", "fail"), ev("simulated", "pass")], true), "cited")
})

test("evidence is appended per module and read back", () => {
	const d = dir()
	appendEvidence([{ ...ev("built", "pass"), module: "motor-stage-drv8833" }, { ...ev("built", "fail"), module: "motor-stage-drv8833" }], d)
	assert.equal(readEvidence("motor-stage-drv8833", d).length, 2)
	assert.deepEqual(readEvidence("nothing", d), [])
})

test("a board that failed at the last revision is a built fail, not a pass from the board before it", () => {
	const used = modulesUsed(loadModules(ROOT), ROVER_BOARD)
	const a = { board: { drc: { errors: 0, unconnected: 0 } }, firmware: { ok: true } } as unknown as Artifacts
	const e = runEvidence(used, a, "r2", 11, "t", { board: "tscircuit build failed (exit 1):\nPCB trace is 6.00mm long" })
	const built = e.filter((x) => x.level === "built")
	assert.ok(built.length > 0 && built.every((x) => x.result === "fail" && /board build failed/.test(x.note ?? "")))
})
