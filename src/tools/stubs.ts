import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Human } from "@mozaik-ai/core"
import { createBuilder } from "../agents/builders.ts"
import type { BoardArtifact, EnclosureArtifact, FirmwareArtifact } from "../contract/consistency.ts"
import type { ContractSnapshot } from "../contract/types.ts"

// --no-hardware: each builder derives its artifact straight from the contract instead of running tscircuit,
// build123d or PlatformIO. The agents, change control, the critic and the consistency checks all run as usual,
// so a machine with only `npm ci` can watch the coordination. Every stub carries stub: true.

type Stub<T> = T & { stub: true }

const SLOT_MARGIN_MM = 0.5

function note(dir: string, kind: string): string {
	const path = join(dir, "STUB.md")
	writeFileSync(path, `# Stubbed ${kind}\n\nThis run used --no-hardware: the ${kind} was derived from the contract, not built.\n`)
	return path
}

export function stubBoard(s: ContractSnapshot, revision: number, dir: string): Stub<BoardArtifact> {
	const { outline, parts, pins } = s.values
	const mcu = parts?.find((p) => p.role === "mcu")?.ref ?? "U1"
	const nets: Record<string, string[]> = {}
	for (const p of pins ?? []) nets[p.signal] = [`${mcu}.GPIO${p.gpio}`, `${p.partRef}.${p.partPin}`]
	return { revision, dir, pcbPath: note(dir, "board"), stepPath: null, renderPath: null, widthMm: outline?.widthMm ?? 0, heightMm: outline?.heightMm ?? 0, nets, stub: true }
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
	return { revision, stlPath: path, stepPath: path, cutouts, stub: true }
}

export function stubFirmware(s: ContractSnapshot, revision: number, dir: string): Stub<FirmwareArtifact> {
	note(dir, "firmware")
	const pins = Object.fromEntries((s.values.pins ?? []).map((p) => [p.signal, p.gpio]))
	return { revision, ok: true, pins, log: "stubbed (--no-hardware): not compiled", stub: true }
}

// Same inputs as the real builders in agents/builders.ts, so the same contract changes wake them.
export function createStubBuilders(): Human[] {
	return [
		createBuilder({ kind: "board", inputs: ["parts", "pins", "outline", "connectors"], build: async ({ snapshot, revision, dir }) => stubBoard(snapshot, revision, dir) }),
		createBuilder({ kind: "enclosure", inputs: ["outline", "connectors"], build: async ({ snapshot, revision, dir }) => stubEnclosure(snapshot, revision, dir) }),
		createBuilder({ kind: "firmware", inputs: ["parts", "pins"], build: async ({ snapshot, revision, dir }) => stubFirmware(snapshot, revision, dir) }),
	]
}

export function isStub(artifact: unknown): boolean {
	return (artifact as { stub?: unknown } | undefined)?.stub === true
}
