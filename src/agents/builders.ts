import { prepareFirmware } from "../tools/firmware.ts"
import { runDrive, type DriveArtifact } from "../tools/drive.ts"
import { buildChassis, chassisSpec, type ChassisArtifact } from "../tools/chassis.ts"
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { createHuman, type Human } from "@mozaik-ai/core"
import type { BoardArtifact, EnclosureArtifact, FirmwareArtifact, TestkitArtifact } from "../contract/consistency.ts"
import { enclosureMode, type ContractSnapshot, type FieldName } from "../contract/types.ts"
import { isEvent, makeEvent, type ArtifactKind } from "../events.ts"
import { emit, state } from "../runtime.ts"
import { when } from "../change-control.ts"
import { Rebuilder } from "../tools/rebuilder.ts"
import { tail } from "../tools/exec.ts"
import { buildBoard } from "../tools/board.ts"
import { exportFab } from "../tools/fab.ts"
import { buildEnclosure } from "../tools/enclosure.ts"
import { buildFirmware } from "../tools/firmware.ts"
import { buildTestkit } from "../tools/testkit.ts"
import type { Env } from "../tools/env.ts"
import type { DrcSummary } from "../tools/drc.ts"

type ArtifactOf = { board: BoardArtifact; enclosure: EnclosureArtifact; firmware: FirmwareArtifact; testkit: TestkitArtifact; chassis: ChassisArtifact; drive: DriveArtifact }

export interface BuildContext {
	revision: number
	snapshot: ContractSnapshot
	dir: string
}

// Fields an artifact can't be built without. Until each has been written (version > 0) a build request is a
// silent skip: no artifact, no artifact.failed, no recorded inputs, so the consistency participant still
// sees the artifact as not current and waits (or ends a stuck run, see consistency.ts).
export const BUILD_REQUIRES: Record<ArtifactKind, FieldName[]> = {
	board: ["outline", "parts", "pins"],
	enclosure: ["outline", "connectors"],
	firmware: ["parts", "pins"],
	testkit: ["test", "outline", "pins"],
	chassis: ["mechanics", "motion", "outline"],
	drive: ["mechanics", "motion", "pins"],
}

// Artifacts a design has only when it asks for them: the test kit exists once the contract has a test field. Without
// that field the kind counts as current (nothing to build), so it never holds a design from settling.
export const OPTIONAL_KINDS: Partial<Record<ArtifactKind, FieldName>> = { testkit: "test", chassis: "mechanics", drive: "mechanics" }
export const ALL_KINDS: ArtifactKind[] = ["board", "enclosure", "firmware", "testkit", "chassis", "drive"]

// Every field that shapes each artifact; a change to one rebuilds it. behavior and model are optional (behavior.h has defaults; model.h says MODEL_PRESENT 0).
export const BUILD_INPUTS: Record<ArtifactKind, FieldName[]> = {
	// test: the board carries a bottom-side test pad for each net the test field names.
	// links: a link's VCC and an I2C link's bus traces (docs/system.md).
	board: ["parts", "pins", "outline", "connectors", "test", "links"],
	// parts: the lid's vent sits over the sensor, wherever the board generator places it. case: walls, height, features.
	enclosure: ["outline", "connectors", "parts", "case"],
	// requirements: the product firmware's sleep period is requirements.dutyCycle.periodS (pins.h DUTY_PERIOD_S).
	// model: model.h sizes the tensor arena and the weights the firmware reserves.
	// connectivity: the radio code, the reports and the partition table (connectivity.h, platformio.ini).
	// links: link.h, the links' protocols and the messages that cross them.
	firmware: ["parts", "pins", "behavior", "requirements", "model", "connectivity", "links"],
	// The test pads follow the board's placement (outline, connectors, parts); the limits follow the power budget (rails,
	// requirements); the self-tests follow the pins and parts.
	testkit: ["test", "outline", "connectors", "parts", "pins", "rails", "requirements"],
	// The chassis follows the mechanics layout, the targets (the payload's mass) and the board's size (its standoffs).
	chassis: ["mechanics", "motion", "outline"],
	// The simulated drive runs the firmware (pins, parts) on the mechanics (mechanics, motion, the board's size).
	drive: ["mechanics", "motion", "pins", "parts", "outline"],
}

// Experiment arm C only (src/experiment): builders sharing one lock take turns, so the same change can be timed with
// its builds awaited one after another instead of concurrently. Runs never pass one.
export class BuildLock {
	private tail: Promise<void> = Promise.resolve()

	run<T>(work: () => Promise<T>): Promise<T> {
		const result = this.tail.then(work)
		this.tail = result.then(
			() => {},
			() => {},
		)
		return result
	}
}

// A plain-code participant that keeps one artifact in step with the contract. It wakes on
// contract.changed for its input fields, runs one build at a time (newer requests coalesce),
// stores the artifact and reports artifact.ready or artifact.failed. Builds of different
// artifacts run concurrently because each builder has its own Rebuilder.
export function createBuilder<K extends ArtifactKind>(opts: {
	kind: K
	inputs: FieldName[]
	requires?: FieldName[]
	build: (ctx: BuildContext) => Promise<ArtifactOf[K]>
	// For tools that report failure in their result instead of throwing.
	failure?: (artifact: ArtifactOf[K]) => string | null
	lock?: BuildLock
	// Why this design has no such artifact, when it has none (no case wanted): the build completes with nothing built.
	notNeeded?: (snapshot: ContractSnapshot) => string | null
}): Human {
	// The notNeeded answer the last build saw: a change to it (case wanted again, or not) rebuilds even though it lives
	// in a field outside the inputs (requirements.enclosure), and only then.
	let lastNeed: string | null | undefined
	const needChanged = () => opts.notNeeded !== undefined && opts.notNeeded(state().contract.snapshot()) !== lastNeed
	const self: { id: string } = { id: "" }
	const rebuilder = new Rebuilder(async (revision) => {
		const s = state()
		const snapshot = s.contract.snapshot()
		if ((opts.requires ?? []).some((f) => snapshot.versions[f] === 0)) return
		const inputs = Object.fromEntries(opts.inputs.map((f) => [f, snapshot.versions[f]]))
		const skipped = opts.notNeeded?.(snapshot) ?? null
		lastNeed = skipped
		if (skipped !== null) {
			// Nothing to build: drop an earlier build (a case made before "no case"), and count it as current.
			delete (s.artifacts as Record<string, unknown>)[opts.kind]
			delete s.artifactFailures[opts.kind]
			s.artifactInputs[opts.kind] = inputs
			emit(makeEvent("artifact.ready", self.id, { kind: opts.kind, revision: snapshot.revision, skipped }), self.id)
			return
		}
		try {
			const dir = join(s.outDir, opts.kind, `rev-${snapshot.revision}`)
			mkdirSync(dir, { recursive: true })
			const ctx = { revision: snapshot.revision, snapshot, dir }
			const artifact = await (opts.lock ? opts.lock.run(() => opts.build(ctx)) : opts.build(ctx))
			;(s.artifacts as Record<string, unknown>)[opts.kind] = artifact
			s.artifactInputs[opts.kind] = inputs
			const failure = opts.failure?.(artifact) ?? null
			if (failure !== null) {
				s.artifactFailures[opts.kind] = failure
				emit(makeEvent("artifact.failed", self.id, { kind: opts.kind, revision: snapshot.revision, error: tail(failure, 40) }), self.id)
				return
			}
			delete s.artifactFailures[opts.kind]
			// A board's KiCad DRC summary rides along, so the dashboard can show it live (not only in report.md).
			const drc = (artifact as { drc?: DrcSummary | null }).drc
			emit(makeEvent("artifact.ready", self.id, { kind: opts.kind, revision: snapshot.revision, ...(drc ? { drc } : {}) }), self.id)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			s.artifactInputs[opts.kind] = inputs
			s.artifactFailures[opts.kind] = message
			emit(makeEvent("artifact.failed", self.id, { kind: opts.kind, revision: snapshot.revision, error: tail(message, 40) }), self.id)
		}
	})
	const builder = createHuman({
		name: `${opts.kind}-builder`,
		capabilities: [],
		handlers: [
			{
				specification: when(({ event }) => isEvent(event, "contract.changed") && (opts.inputs.includes(event.payload.field) || (lastNeed !== undefined && needChanged()))),
				processor: {
					apply: ({ event }) => {
						if (isEvent(event, "contract.changed")) rebuilder.request(event.payload.revision)
					},
				},
			},
		],
	})
	self.id = builder.getId()
	return Object.assign(builder, { rebuilder })
}

// The three domain builders. Each depends only on the contract fields that shape its artifact,
// so a pin change rebuilds the board and firmware while the enclosure keeps working undisturbed.
export function createBoardBuilder(env: Env, lock?: BuildLock): Human {
	return createBuilder({
		kind: "board",
		lock,
		inputs: BUILD_INPUTS.board,
		requires: BUILD_REQUIRES.board,
		build: async ({ dir, snapshot, revision }) => {
			const board = await buildBoard(env, dir, snapshot, revision)
			// Stable path for the dashboard: the latest render is always at <out>/board/board.png.
			if (board.renderPath) copyFileSync(board.renderPath, join(state().outDir, "board", "board.png"))
			// The fab package is best-effort: a failed export is recorded on the artifact, not a failed build.
			// The latest one is also copied to <out>/fab.
			try {
				const fab = await exportFab(env, board, snapshot, dir)
				board.fabDir = fab.dir
				const latest = join(state().outDir, "fab")
				rmSync(latest, { recursive: true, force: true })
				cpSync(fab.dir, latest, { recursive: true })
			} catch (error) {
				board.fabError = error instanceof Error ? error.message : String(error)
			}
			if (existsSync(join(dir, "dist/board/circuit.json"))) copyFileSync(join(dir, "dist/board/circuit.json"), join(state().outDir, "board", "circuit.json"))
			return board
		},
	})
}

// The case is built only when the design wants one of ours (requirements.enclosure "case", the default).
export function caseNotNeeded(s: ContractSnapshot): string | null {
	const mode = enclosureMode(s.values)
	return mode === "none" ? "no case: a bare board (requirements.enclosure none)" : mode === "own" ? "no case: it goes into the engineer's own housing (requirements.enclosure own); see interface.md" : null
}

// A robot's chassis (docs/mechanics.md): py/chassis.py from the mechanics field; a design without one has none.
export const chassisNotNeeded = (s: ContractSnapshot) => (s.values.mechanics ? null : "no mechanics design: not a robot")
export function createChassisBuilder(env: Env, lock?: BuildLock): Human {
	return createBuilder({
		kind: "chassis",
		lock,
		inputs: BUILD_INPUTS.chassis,
		requires: BUILD_REQUIRES.chassis,
		notNeeded: chassisNotNeeded,
		build: async ({ dir, snapshot, revision }) => {
			if (!env.python) throw new Error("chassis build failed: .venv python with build123d is not installed")
			const r = await buildChassis(env.python, env.root, dir, snapshot, revision)
			if (!r.ok) throw new Error(`chassis build failed: ${r.reason}`)
			return r
		},
	})
}

// The firmware-in-the-loop drive (docs/mechanics.md): the rover's simulation build in QEMU drives MuJoCo over the
// course. Without QEMU or PlatformIO the design can still settle on the plain checks: the artifact says "not run".
export function createDriveBuilder(env: Env, lock?: BuildLock): Human {
	return createBuilder({
		kind: "drive",
		lock,
		inputs: BUILD_INPUTS.drive,
		requires: BUILD_REQUIRES.drive,
		notNeeded: chassisNotNeeded,
		build: async ({ dir, snapshot, revision }) => {
			const notRun = (reason: string): DriveArtifact => ({ revision, dir, result: "not run", reason, segments: [] })
			if (!env.pio || !env.qemu || !env.python) return notRun("PlatformIO, QEMU or the .venv simulation tools are missing: not proven in simulation")
			const spec = chassisSpec(snapshot)
			if (!spec) return notRun("no complete mechanics design to simulate")
			const fw = join(dir, "fw")
			await prepareFirmware(env.root, fw, snapshot)
			return runDrive({ root: env.root, python: env.python, pio: env.pio, fwDir: fw, spec, outDir: dir }, revision)
		},
	})
}

export function createEnclosureBuilder(env: Env, lock?: BuildLock): Human {
	return createBuilder({
		kind: "enclosure",
		lock,
		inputs: BUILD_INPUTS.enclosure,
		requires: BUILD_REQUIRES.enclosure,
		notNeeded: caseNotNeeded,
		build: ({ dir, snapshot, revision }) => {
			if (!env.python) throw new Error("enclosure build failed: .venv python with build123d is not installed")
			return buildEnclosure(env.python, env.root, dir, snapshot, revision)
		},
	})
}

export function createFirmwareBuilder(env: Env, lock?: BuildLock): Human {
	return createBuilder({
		kind: "firmware",
		lock,
		inputs: BUILD_INPUTS.firmware,
		requires: BUILD_REQUIRES.firmware,
		build: ({ dir, snapshot, revision }) => {
			if (!env.pio) throw new Error("firmware build failed: .venv PlatformIO is not installed")
			return buildFirmware(env.pio, env.root, dir, snapshot, revision)
		},
		failure: (fw) => (fw.ok ? null : `firmware does not compile:\n${fw.log}`),
	})
}

// The production-test kit: the plan, the fixture and the factory-test firmware, from the same revision as the board's
// test pads. Fails only when the fixture or the firmware can't be made, not when a tool is missing (that is recorded).
export function createTestkitBuilder(env: Env, lock?: BuildLock): Human {
	return createBuilder({
		kind: "testkit",
		lock,
		inputs: BUILD_INPUTS.testkit,
		requires: BUILD_REQUIRES.testkit,
		build: ({ dir, snapshot, revision }) => buildTestkit(env, env.root, dir, snapshot, revision),
		failure: (kit) => (env.pio && !kit.firmware.ok ? `factory-test firmware does not compile:\n${kit.firmware.log}` : kit.fixtureIssues.find((i) => !/not installed/.test(i)) ?? null),
	})
}
