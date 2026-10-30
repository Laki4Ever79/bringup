import { copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { createHuman, type Human } from "@mozaik-ai/core"
import type { BoardArtifact, EnclosureArtifact, FirmwareArtifact } from "../contract/consistency.ts"
import type { ContractSnapshot, FieldName } from "../contract/types.ts"
import { isEvent, makeEvent, type ArtifactKind } from "../events.ts"
import { emit, state } from "../runtime.ts"
import { when } from "../change-control.ts"
import { Rebuilder } from "../tools/rebuilder.ts"
import { tail } from "../tools/exec.ts"
import { buildBoard } from "../tools/board.ts"
import { exportFab } from "../tools/fab.ts"
import { buildEnclosure } from "../tools/enclosure.ts"
import { buildFirmware } from "../tools/firmware.ts"
import type { Env } from "../tools/env.ts"

type ArtifactOf = { board: BoardArtifact; enclosure: EnclosureArtifact; firmware: FirmwareArtifact }

export interface BuildContext {
	revision: number
	snapshot: ContractSnapshot
	dir: string
}

// A plain-code participant that keeps one artifact in step with the contract. It wakes on
// contract.changed for its input fields, runs one build at a time (newer requests coalesce),
// stores the artifact and reports artifact.ready or artifact.failed. Builds of different
// artifacts run concurrently because each builder has its own Rebuilder.
export function createBuilder<K extends ArtifactKind>(opts: {
	kind: K
	inputs: FieldName[]
	build: (ctx: BuildContext) => Promise<ArtifactOf[K]>
	// For tools that report failure in their result instead of throwing.
	failure?: (artifact: ArtifactOf[K]) => string | null
}): Human {
	const self: { id: string } = { id: "" }
	const rebuilder = new Rebuilder(async (revision) => {
		const s = state()
		const snapshot = s.contract.snapshot()
		const inputs = Object.fromEntries(opts.inputs.map((f) => [f, snapshot.versions[f]]))
		try {
			const dir = join(s.outDir, opts.kind, `rev-${snapshot.revision}`)
			mkdirSync(dir, { recursive: true })
			const artifact = await opts.build({ revision: snapshot.revision, snapshot, dir })
			;(s.artifacts as Record<string, unknown>)[opts.kind] = artifact
			s.artifactInputs[opts.kind] = inputs
			const failure = opts.failure?.(artifact) ?? null
			if (failure !== null) {
				s.artifactFailures[opts.kind] = failure
				emit(makeEvent("artifact.failed", self.id, { kind: opts.kind, revision: snapshot.revision, error: tail(failure, 40) }), self.id)
				return
			}
			delete s.artifactFailures[opts.kind]
			emit(makeEvent("artifact.ready", self.id, { kind: opts.kind, revision: snapshot.revision }), self.id)
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
				specification: when(({ event }) => isEvent(event, "contract.changed") && opts.inputs.includes(event.payload.field)),
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
export function createBoardBuilder(env: Env): Human {
	return createBuilder({
		kind: "board",
		inputs: ["parts", "pins", "outline", "connectors"],
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
			return board
		},
	})
}

export function createEnclosureBuilder(env: Env): Human {
	return createBuilder({
		kind: "enclosure",
		inputs: ["outline", "connectors"],
		build: ({ dir, snapshot, revision }) => {
			if (!env.python) throw new Error("enclosure build failed: .venv python with build123d is not installed")
			return buildEnclosure(env.python, env.root, dir, snapshot, revision)
		},
	})
}

export function createFirmwareBuilder(env: Env): Human {
	return createBuilder({
		kind: "firmware",
		inputs: ["parts", "pins"],
		build: ({ dir, snapshot, revision }) => {
			if (!env.pio) throw new Error("firmware build failed: .venv PlatformIO is not installed")
			return buildFirmware(env.pio, env.root, dir, snapshot, revision)
		},
		failure: (fw) => (fw.ok ? null : `firmware does not compile:\n${fw.log}`),
	})
}
