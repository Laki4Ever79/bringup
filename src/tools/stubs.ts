import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Human } from "@mozaik-ai/core"
import { BUILD_INPUTS, BUILD_REQUIRES, createBuilder, type BuildLock } from "../agents/builders.ts"
import { mountingHoles, placeParts } from "../codegen/circuit.ts"
import { behaviorHeader, parseSensorHeader, pinsHeader } from "../codegen/firmware.ts"
import { STANDOFF } from "./enclosure.ts"
import type { BoardArtifact, EnclosureArtifact, FirmwareArtifact } from "../contract/consistency.ts"
import type { ContractSnapshot } from "../contract/types.ts"

// --no-hardware: each builder derives its artifact straight from the contract instead of running tscircuit,
// build123d or PlatformIO. The agents, change control, the grounding check and the consistency checks all run as
// usual, so a machine with only `npm ci` can watch the coordination. Every stub carries stub: true.

type Stub<T> = T & { stub: true }

const SLOT_MARGIN_MM = 0.5

function note(dir: string, kind: string): string {
	const path = join(dir, "STUB.md")
	writeFileSync(path, `# Stubbed ${kind}\n\nThis run used --no-hardware: the ${kind} was derived from the contract, not built.\n`)
	return path
}

// The mounting holes the board codegen would drill, in the contract frame.
function holesOf(s: ContractSnapshot): { xMm: number; yMm: number; diameterMm: number }[] {
	const { outline } = s.values
	if (!outline) return []
	return mountingHoles(s).map((h) => ({ xMm: h.x + outline.widthMm / 2, yMm: h.y + outline.heightMm / 2, diameterMm: h.diameterMm }))
}

// Each sensor where the board generator places it, in the contract frame.
function sensorsOf(s: ContractSnapshot): { ref: string; xMm: number; yMm: number }[] {
	const { outline, parts = [] } = s.values
	const refs = new Set(parts.filter((p) => p.role === "sensor").map((p) => p.ref))
	if (!outline || refs.size === 0) return []
	return placeParts(s).filter((p) => refs.has(p.ref)).map((p) => ({ ref: p.ref, xMm: p.x + outline.widthMm / 2, yMm: p.y + outline.heightMm / 2 }))
}

export function stubBoard(s: ContractSnapshot, revision: number, dir: string): Stub<BoardArtifact> {
	const { outline, parts, pins } = s.values
	const mcu = parts?.find((p) => p.role === "mcu")?.ref ?? "U1"
	const nets: Record<string, string[]> = {}
	for (const p of pins ?? []) nets[p.signal] = [`${mcu}.GPIO${p.gpio}`, `${p.partRef}.${p.partPin}`]
	return { revision, dir, pcbPath: note(dir, "board"), stepPath: null, renderPath: null, widthMm: outline?.widthMm ?? 0, heightMm: outline?.heightMm ?? 0, nets, holes: holesOf(s), parts: Object.fromEntries((parts ?? []).map((p) => [p.ref, { mpn: p.mpn, pins: p.pins }])), placements: Object.fromEntries(sensorsOf(s).map(({ ref, xMm, yMm }) => [ref, { xMm, yMm }])), stub: true }
}

export function stubEnclosure(s: ContractSnapshot, revision: number, dir: string): Stub<EnclosureArtifact> {
	const path = note(dir, "enclosure")
	const cutouts = (s.values.connectors ?? []).map((c) => ({
		ref: c.ref,
		edge: c.edge,
		offsetMm: c.offsetMm,
		widthMm: c.widthMm + 2 * SLOT_MARGIN_MM,
		heightMm: c.heightMm + 2 * SLOT_MARGIN_MM,
	}))
	const standoffs = holesOf(s).map((h) => ({ xMm: h.xMm, yMm: h.yMm, holeMm: STANDOFF.pilotMm }))
	const vents = sensorsOf(s).map((v) => ({ ...v, widthMm: 8.4, heightMm: 6 }))
	return { revision, stlPath: path, stepPath: path, cutouts, standoffs, vents, stub: true }
}

export function stubFirmware(s: ContractSnapshot, revision: number, dir: string): Stub<FirmwareArtifact> {
	note(dir, "firmware")
	// The headers the real build compiles, so the bench (fake bridge) can "flash" a stubbed firmware too.
	mkdirSync(join(dir, "include"), { recursive: true })
	const header = pinsHeader(s)
	writeFileSync(join(dir, "include/pins.h"), header)
	writeFileSync(join(dir, "include/behavior.h"), behaviorHeader(s))
	const pins = Object.fromEntries((s.values.pins ?? []).map((p) => [p.signal, p.gpio]))
	return { revision, ok: true, pins, sensor: parseSensorHeader(header), log: "stubbed (--no-hardware): not compiled", stub: true }
}

// Same inputs and required fields as the real builders in agents/builders.ts, so the same contract changes wake them.
export function createStubBuilders(lock?: BuildLock): Human[] {
	return [
		createBuilder({ kind: "board", inputs: BUILD_INPUTS.board, requires: BUILD_REQUIRES.board, lock, build: async ({ snapshot, revision, dir }) => stubBoard(snapshot, revision, dir) }),
		createBuilder({ kind: "enclosure", inputs: BUILD_INPUTS.enclosure, requires: BUILD_REQUIRES.enclosure, lock, build: async ({ snapshot, revision, dir }) => stubEnclosure(snapshot, revision, dir) }),
		createBuilder({ kind: "firmware", inputs: BUILD_INPUTS.firmware, requires: BUILD_REQUIRES.firmware, lock, build: async ({ snapshot, revision, dir }) => stubFirmware(snapshot, revision, dir) }),
	]
}

export function isStub(artifact: unknown): boolean {
	return (artifact as { stub?: unknown } | undefined)?.stub === true
}
