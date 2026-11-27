import { BUILDS } from "../contract/builds.js"
import { qemuTarget } from "../tools/qemu.ts"
import { mcuProfileOf } from "../mcu/profile.ts"
import { unassignedRoverPins } from "../mechanics/firmware.ts"
import { prepareFirmware } from "../tools/firmware.ts"
import { armSimSpec, runArmDrive, runDrive, type ArmDriveArtifact, type DriveArtifact } from "../tools/drive.ts"
import { buildArm, type ArmArtifact } from "../tools/arm.ts"
import { buildChassis, chassisSpec, type ChassisArtifact } from "../tools/chassis.ts"
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createHuman, type Human } from "@mozaik-ai/core"
import type { BoardArtifact, EnclosureArtifact, FirmwareArtifact, TestkitArtifact } from "../contract/consistency.ts"
import { enclosureMode, type ContractSnapshot, type FieldName } from "../contract/types.ts"
import { isEvent, makeEvent, type ArtifactKind } from "../events.ts"
import { emit, state } from "../runtime.ts"
import { when } from "../change-control.ts"
import { Rebuilder } from "../tools/rebuilder.ts"
import { failureExcerpt, run, tail } from "../tools/exec.ts"
import { buildBoard } from "../tools/board.ts"
import { chipInstances } from "../codegen/circuit.ts"
import { exportFab } from "../tools/fab.ts"
import { buildEnclosure } from "../tools/enclosure.ts"
import { buildFirmware } from "../tools/firmware.ts"
import { cncSimReady, runCncSim, type CncSimArtifact } from "../tools/cnc-sim.ts"
import { buildTestkit } from "../tools/testkit.ts"
import type { Env } from "../tools/env.ts"
import type { DrcSummary } from "../tools/drc.ts"

type ArtifactOf = { board: BoardArtifact; enclosure: EnclosureArtifact; firmware: FirmwareArtifact; testkit: TestkitArtifact; chassis: ChassisArtifact; drive: DriveArtifact; arm: ArmBuildArtifact; armsim: ArmDriveArtifact & { stub?: true }; cncsim: CncSimArtifact }

export interface BuildContext {
	revision: number
	snapshot: ContractSnapshot
	dir: string
}

// What each artifact is built from: src/contract/builds.js, shared with the dashboard (its reasons are there).
export const BUILD_REQUIRES = Object.fromEntries(Object.entries(BUILDS).map(([k, b]) => [k, b.requires])) as Record<ArtifactKind, FieldName[]>
export const BUILD_INPUTS = Object.fromEntries(Object.entries(BUILDS).map(([k, b]) => [k, b.inputs])) as Record<ArtifactKind, FieldName[]>
// Artifacts a design has only when it asks for them: without the field the kind counts as current (nothing to build),
// so it never holds a design from settling.
export const OPTIONAL_KINDS = Object.fromEntries(Object.entries(BUILDS).filter(([, b]) => b.optional).map(([k, b]) => [k, b.optional])) as Partial<Record<ArtifactKind, FieldName>>
export const ALL_KINDS: ArtifactKind[] = ["board", "enclosure", "firmware", "testkit", "chassis", "drive", "arm", "armsim", "cncsim"]

// Experiment arm C only (src/experiment): builders sharing one lock take turns, so the same change can be timed with
// its builds awaited one after another instead of concurrently. Runs never pass one.
// The builds running now, by kind, with their start time: the run waits for them at its time cap (runner/run-time.ts).
export const buildsInFlight = new Map<string, number>()

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
	// Values outside the inputs that shape the artifact (a few in a large field): a change to `fields` rebuilds it only
	// when `key` changes, and the dedupe below counts it.
	derived?: { fields: FieldName[]; key: (snapshot: ContractSnapshot) => unknown }
	// A short summary of the built artifact, carried on artifact.ready under the kind's name (the Drive tile's result).
	summary?: (artifact: ArtifactOf[K]) => Record<string, unknown>
}): Human {
	// The notNeeded answer the last build saw: a change to it (case wanted again, or not) rebuilds even though it lives
	// in a field outside the inputs (requirements.enclosure), and only then.
	let lastNeed: string | null | undefined
	const needChanged = () => opts.notNeeded !== undefined && opts.notNeeded(state().contract.snapshot()) !== lastNeed
	const self: { id: string } = { id: "" }
	// What the last successful build was built from, documentation left out: a change that only rewrites why (a part's
	// reason) builds nothing new, so the last artifact stands for the new revision (rover run cc-rover-7 on the Claude
	// subscription, 16 Nov 2026: the parts agent reworded D1's reason, the board rebuilt for 26 minutes and the run's
	// hour ran out waiting for it).
	let lastBuilt: string | null = null
	let lastKey: string | null = null
	// The derived key this build is from (lastKey), kept beside the input versions so "current" counts it too.
	const recordDerived = () => {
		if (!opts.derived || lastKey === null) return
		const key = opts.derived.key
		state().artifactDerived[opts.kind] = { built: lastKey, now: () => JSON.stringify(key(state().contract.snapshot()) ?? null) }
	}
	const keyChanged = (field: string) => Boolean(opts.derived?.fields.includes(field as FieldName)) && JSON.stringify(opts.derived!.key(state().contract.snapshot()) ?? null) !== lastKey
	// Steering (runner/steer.ts): a paused or stopped builder starts no build until it is resumed; Redo rebuilds the
	// current revision even when its inputs haven't changed. A build in flight is never killed: it finishes.
	const name = `${opts.kind}-builder`
	state().steer.register(name, "builder")
	let force = false
	const rebuilder = new Rebuilder(async (revision) => {
		await state().steer.gate(name)
		// How long this build took, on the artifact's event (profiling a slow OS: the Windows rover, 27 Nov 2026).
		const t0 = Date.now()
		const s = state()
		const snapshot = s.contract.snapshot()
		const forced = force
		force = false
		state().steer.noteStep(name, `build ${opts.kind} at rev ${snapshot.revision}`, () => {
			force = true
			rebuilder.redo(state().contract.revision)
		})
		if ((opts.requires ?? []).some((f) => snapshot.versions[f] === 0)) return
		const inputs = Object.fromEntries(opts.inputs.map((f) => [f, snapshot.versions[f]]))
		const skipped = opts.notNeeded?.(snapshot) ?? null
		lastNeed = skipped
		if (skipped !== null) {
			// Nothing to build: drop an earlier build (a case made before "no case"), and count it as current.
			delete (s.artifacts as Record<string, unknown>)[opts.kind]
			delete s.artifactFailures[opts.kind]
			s.artifactInputs[opts.kind] = inputs
			recordDerived()
			emit(makeEvent("artifact.ready", self.id, { kind: opts.kind, revision: snapshot.revision, skipped }), self.id)
			return
		}
		const built = physical([...opts.inputs.map((f) => snapshot.values[f]), opts.derived?.key(snapshot) ?? null])
		lastKey = JSON.stringify(opts.derived?.key(snapshot) ?? null)
		if (!forced && built === lastBuilt && (s.artifacts as Record<string, unknown>)[opts.kind] !== undefined && !s.artifactFailures[opts.kind]) {
			s.artifactInputs[opts.kind] = inputs
			recordDerived()
			const drc = ((s.artifacts as Record<string, unknown>)[opts.kind] as { drc?: DrcSummary | null }).drc
			emit(makeEvent("artifact.ready", self.id, { kind: opts.kind, revision: snapshot.revision, ...(drc ? { drc } : {}), ms: Date.now() - t0 }), self.id)
			return
		}
		try {
			const dir = join(s.outDir, opts.kind, `rev-${snapshot.revision}`)
			mkdirSync(dir, { recursive: true })
			const ctx = { revision: snapshot.revision, snapshot, dir }
			buildsInFlight.set(opts.kind, Date.now())
			const artifact = await (opts.lock ? opts.lock.run(() => opts.build(ctx)) : opts.build(ctx)).finally(() => buildsInFlight.delete(opts.kind))
			;(s.artifacts as Record<string, unknown>)[opts.kind] = artifact
			s.artifactInputs[opts.kind] = inputs
			recordDerived()
			const failure = opts.failure?.(artifact) ?? null
			if (failure !== null) {
				s.artifactFailures[opts.kind] = failure
				emit(makeEvent("artifact.failed", self.id, { kind: opts.kind, revision: snapshot.revision, error: failureExcerpt(failure, 40), ms: Date.now() - t0 }), self.id)
				return
			}
			delete s.artifactFailures[opts.kind]
			lastBuilt = built
			// A board's KiCad DRC summary rides along, so the dashboard can show it live (not only in report.md).
			const drc = (artifact as { drc?: DrcSummary | null }).drc
			const summary = opts.summary?.(artifact as ArtifactOf[K])
			emit(makeEvent("artifact.ready", self.id, { kind: opts.kind, revision: snapshot.revision, ...(drc ? { drc } : {}), ...(summary ? { [opts.kind]: summary } : {}), ms: Date.now() - t0 }), self.id)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			s.artifactInputs[opts.kind] = inputs
			recordDerived()
			s.artifactFailures[opts.kind] = message
			emit(makeEvent("artifact.failed", self.id, { kind: opts.kind, revision: snapshot.revision, error: failureExcerpt(message, 40), ms: Date.now() - t0 }), self.id)
		}
	})
	const builder = createHuman({
		name: `${opts.kind}-builder`,
		capabilities: [],
		handlers: [
			{
				specification: when(({ event }) => isEvent(event, "contract.changed") && (opts.inputs.includes(event.payload.field) || keyChanged(event.payload.field) || (lastNeed !== undefined && needChanged()))),
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

// What the board generator reads from mechanics and requirements (src/codegen/circuit.ts): the skid-steer rear driver,
// the sensor plug's VCC, the debug port, the duty cycle and USB wake (power and pads), and the test pads.
export const BOARD_DERIVED = (s: ContractSnapshot) => {
	const m = s.values.mechanics, r = s.values.requirements
	// chips: what each catalog chip's context hands it (chipInstances: a CNC driver's motor rail, address and plug nets,
	// read from the cnc field). Without it the CNC board built before mechanics wrote cnc was never rebuilt: no motor
	// rail, every plug unconnected, "supply-unwired J2.VIN" to the end (CNC mock 9, 26 Nov 2026).
	let chips: unknown = null
	try { chips = chipInstances(s).map((i) => [i.part.ref, i.ctx]) } catch { /* a contract the generator can't wire yet */ }
	return { driveKind: m?.drive.kind ?? null, sensorPlug: m?.sensor?.connector ?? null, debugPort: r?.debugPort ?? null, dutyCycle: r?.dutyCycle ?? null, usbWake: r?.usbWake ?? null, testPads: r?.testPads ?? null, chips }
}

// Each artifact's derived inputs (createBuilder's derived), shared by the real builders and the stubs (tools/stubs.ts):
// the stub board had none, so under --no-hardware a robot's mechanics (its sensor plug's 3V3) never rebuilt the board,
// and the scripted rover ended on "supply-unwired JT1.VCC" (17 Nov 2026).
export const BUILD_DERIVED: Partial<Record<ArtifactKind, { fields: FieldName[]; key: (s: ContractSnapshot) => unknown }>> = {
	board: { fields: ["mechanics", "requirements", "cnc"], key: BOARD_DERIVED },
}

// The three domain builders. Each depends only on the contract fields that shape its artifact,
// so a pin change rebuilds the board and firmware while the enclosure keeps working undisturbed.
export function createBoardBuilder(env: Env, lock?: BuildLock): Human {
	return createBuilder({
		kind: "board",
		lock,
		inputs: BUILD_INPUTS.board,
		derived: BUILD_DERIVED.board,
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
export const chassisNotNeeded = (s: ContractSnapshot) => (!s.values.mechanics ? "no mechanics design: not a robot" : !s.values.motion ? "no motion targets: nothing to build the robot against" : null)
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

// A robot arm's printed parts and their sweep (src/tools/arm.ts): the clashes and print problems become arm-interference
// and arm-dfm violations for the mechanics engineer (src/contract/consistency.ts). A design without an arm field has none.
export type ArmBuildArtifact = ArmArtifact & { revision: number; stub?: true }
export const armNotNeeded = (s: ContractSnapshot) => (!s.values.arm ? "no arm design: not a robot arm" : null)
export function createArmBuilder(env: Env, lock?: BuildLock): Human {
	return createBuilder({
		kind: "arm",
		lock,
		inputs: BUILD_INPUTS.arm,
		requires: BUILD_REQUIRES.arm,
		notNeeded: armNotNeeded,
		build: async ({ dir, snapshot, revision }) => {
			if (!env.python) throw new Error("arm build failed: .venv python with build123d is not installed")
			const r = await buildArm(env.python, env.root, dir, snapshot.values)
			if (!r.ok) throw new Error(`arm build failed: ${r.reason}`)
			return { ...r, revision }
		},
	})
}

// The arm's pick-and-place in the loop (arm task 8): the arm firmware's simulation build in QEMU drives the MuJoCo arm
// (py/mech/arm_model.py, made from this contract) through the brief's picks and drops; arm.json says how many landed.
// Without PlatformIO, QEMU or MuJoCo the design can still settle on the plain checks: the artifact says "not run".
export function createArmSimBuilder(env: Env, lock?: BuildLock): Human {
	return createBuilder({
		kind: "armsim",
		lock,
		inputs: BUILD_INPUTS.armsim,
		requires: BUILD_REQUIRES.armsim,
		notNeeded: armNotNeeded,
		build: async ({ dir, snapshot, revision }) => {
			const notRun = (reason: string): ArmDriveArtifact => ({ revision, dir, result: "not run", reason, note: "" })
			if (!env.pio || !env.qemu || !env.python) return notRun("PlatformIO, QEMU or the .venv simulation tools are missing: not proven in simulation")
			if (!snapshot.values.armTargets) return notRun("no arm targets: nothing to pick and place")
			const chip = mcuProfileOf(snapshot.values.parts)
			const machine = chip ? chip.sim.machine : "esp32s3"
			if (chip && (chip.sim.backend !== "qemu" || !qemuTarget(machine))) return notRun(`arm sim: not run: it runs the firmware in Espressif's QEMU (ESP32-C3, ESP32-S3), not the ${chip.mpn}'s`)
			mkdirSync(dir, { recursive: true })
			const contract = join(dir, "contract.json"), mjcf = join(dir, "arm.xml")
			writeFileSync(contract, JSON.stringify(snapshot))
			const m = await run(env.python, ["-B", join(env.root, "py/mech/arm_model.py"), contract, mjcf], { cwd: join(env.root, "py"), env: { ...(process.env as Record<string, string>), PYTHONPATH: join(env.root, "py") }, timeoutMs: 120_000 })
			if (m.code !== 0) return notRun(`the arm's simulation model didn't build: ${(m.stdout + m.stderr).trim().split("\n").at(-1)}`)
			const fw = join(dir, "fw")
			await prepareFirmware(env.root, fw, snapshot)
			return runArmDrive({ root: env.root, python: env.python, pio: env.pio, fwDir: fw, outDir: dir, spec: armSimSpec(snapshot, mjcf), machine, timeoutMs: 900_000 }, revision)
		},
	})
}

// A CNC's firmware in the loop (gap 12, src/tools/cnc-sim.ts): grblHAL's simulation build from this contract runs in
// Renode through the scenario (a move on every axis, the e-stop, a stall, a hard limit). Without PlatformIO, the grblHAL
// clone or Renode in tools/ the design still settles on the plain checks: the artifact says "not run".
export const cncNotNeeded = (s: ContractSnapshot) => (!s.values.cnc ? "no cnc design: not a machine tool" : null)
export function createCncSimBuilder(env: Env, lock?: BuildLock): Human {
	return createBuilder({
		kind: "cncsim",
		lock,
		inputs: BUILD_INPUTS.cncsim,
		requires: BUILD_REQUIRES.cncsim,
		notNeeded: cncNotNeeded,
		build: async ({ dir, snapshot, revision }) => {
			const notRun = (reason: string): CncSimArtifact => ({ revision, dir, result: "not run", reason, checks: [], knownLimits: [] })
			if (snapshot.values.cnc?.firmware !== "grblhal") return notRun(`the simulation runs grblHAL; this machine's firmware is ${snapshot.values.cnc?.firmware ?? "unset"}`)
			if (!env.pio || !cncSimReady(env.root)) return notRun("PlatformIO, grblHAL's STM32F4xx clone or Renode 1.17 is missing in tools/: not proven in simulation")
			mkdirSync(dir, { recursive: true })
			const r = runCncSim(env.root, snapshot, dir)
			const failed = r.checks.filter((c) => !c.ok)
			return { revision, dir, result: r.result, reason: failed.map((c) => `${c.name}: ${c.detail}`).join("; "), checks: r.checks, knownLimits: r.knownLimits, wallS: r.wallS }
		},
	})
}

// Why the drive can't run yet: another board on the chassis has only an estimated outline, and the drive's mass follows it.
export function estimatedOutlineReason(snapshot: ContractSnapshot, spec: { boards: { name: string }[] }): string | null {
	const a = snapshot.values.assembly
	const guessed = (a?.boards ?? []).find((b) => b.name !== a?.self && b.outlineSource === "estimate" && spec.boards.some((p) => p.name === b.name))
	return guessed ? `board ${guessed.name}'s outline is an estimate until it is built, so the drive would guess its weight` : null
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
		summary: driveSummary,
		build: async ({ dir, snapshot, revision }) => {
			const notRun = (reason: string): DriveArtifact => ({ revision, dir, result: "not run", reason, segments: [] })
			if (!env.pio || !env.qemu || !env.python) return notRun("PlatformIO, QEMU or the .venv simulation tools are missing: not proven in simulation")
			// The drive runs the firmware in the chip's QEMU (tools/qemu.ts: riscv32 for the ESP32-C3, xtensa for the S3); an
			// MCU it has no machine for isn't simulated.
			const chip = mcuProfileOf(snapshot.values.parts)
			const machine = chip ? chip.sim.machine : "esp32c3"
			if (chip && (chip.sim.backend !== "qemu" || !qemuTarget(machine)))
				return notRun(`drive sim: not run: the drive simulation runs the firmware in Espressif's QEMU (ESP32-C3, ESP32-S3), not the ${chip.mpn}'s`)
			const spec = chassisSpec(snapshot)
			if (!spec) return notRun("no complete mechanics design to simulate")
			// Driving without a board's weight would prove a lighter robot than the real one.
			if (spec.unplaced.length) return notRun(`board${spec.unplaced.length > 1 ? "s" : ""} ${spec.unplaced.join(", ")} on the chassis ${spec.unplaced.length > 1 ? "have" : "has"} no outline in this run, so the drive would leave out ${spec.unplaced.length > 1 ? "their" : "its"} weight`)
			const guessed = estimatedOutlineReason(snapshot, spec)
			if (guessed) return notRun(guessed)
			// A firmware with a -1 pin drives nothing: the wiring check flags it; no build until the pins are there.
			const unassigned = unassignedRoverPins(snapshot)
			if (unassigned.length) return notRun(`pins not assigned yet: ${unassigned.join(", ")}`)
			const fw = join(dir, "fw")
			await prepareFirmware(env.root, fw, snapshot)
			return runDrive({ root: env.root, python: env.python, pio: env.pio, fwDir: fw, spec, outDir: dir, machine }, revision)
		},
	})
}

// How the simulated drive went, for the Drive tile: its result and the first segment that failed.
// A drive that wasn't run says why (QEMU or MuJoCo missing, pins not assigned yet), for the system trace and the tile.
export function driveSummary(d: DriveArtifact): { result: DriveArtifact["result"]; failed?: string; reason?: string } {
	const failed = d.segments.find((x) => !x.pass)?.name
	if (d.result === "fail" && failed) return { result: d.result, failed }
	return d.result === "not run" && d.reason ? { result: d.result, reason: d.reason } : { result: d.result }
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
		failure: (fw) => (!fw.ok ? `firmware does not compile:\n${fw.log}` : fw.driverTests?.ok === false ? `firmware drivers fail their host tests: ${fw.driverTests.failed.map((f) => `${f.name}: ${f.message}`).join("; ")}` : null),
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

// The build inputs as JSON with every "reason" key left out: what a build is made from, not why.
function physical(values: unknown[]): string {
	return JSON.stringify(values, (key, value) => (key === "reason" ? undefined : value))
}
