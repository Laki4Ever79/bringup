import { readFileSync, watch, type FSWatcher } from "node:fs"
import { join } from "node:path"
import { createHuman, type Human } from "@mozaik-ai/core"
import { BUILD_INPUTS } from "../agents/builders.ts"
import { macroName, pinsHeader } from "../codegen/firmware.ts"
import type { ContractSnapshot, PinAssignment } from "../contract/types.ts"
import { isEvent, makeEvent, type FileSource, type Payloads } from "../events.ts"
import { emit, state } from "../runtime.ts"
import { appendRequest } from "./requests.ts"

// "Edit the file, the design follows": on a run that stays up, a saved generated file is diffed against what Bringup
// generated for that revision. Differences that map to a contract field become an engineer change request (the same
// path as --change: requests.jsonl → change.requested → the owners decide). Everything else is a file.drift warning.

const DEBOUNCE_MS = 300
const PINS_H = /^firmware\/rev-(\d+)\/include\/pins\.h$/
const DRIFT_MESSAGE = "this edit isn't in the design contract; the next rebuild will overwrite it"

export interface PinsEdits {
	// One line per edit the contract can take, e.g. "I2C_SDA GPIO8 → GPIO4".
	mapped: string[]
	// The contract's pins with the mapped edits applied; null when nothing mapped.
	pins: PinAssignment[] | null
	// One line per edit it can't: a new or removed define, a hand-edited line.
	drift: string[]
}

function parse(text: string): { defines: Map<string, string>; other: string[] } {
	const defines = new Map<string, string>()
	const other: string[] = []
	for (const raw of text.split("\n")) {
		const line = raw.trim()
		if (!line) continue
		const m = /^#define\s+(\w+)(?:\s+(.*?))?\s*$/.exec(line)
		if (m) defines.set(m[1], m[2] ?? "")
		else other.push(line)
	}
	return { defines, other }
}

// Pure: what a saved pins.h changes against the one Bringup generated from snapshot s.
export function pinsEdits(saved: string, generated: string, s: ContractSnapshot): PinsEdits {
	const was = parse(generated)
	const now = parse(saved)
	const pins = structuredClone(s.values.pins ?? [])
	const mapped: string[] = []
	const drift: string[] = []
	const show = (name: string, value: string) => `#define ${name}${value ? ` ${value}` : ""}`
	for (const [name, value] of now.defines) {
		const before = was.defines.get(name)
		if (before === value) continue
		if (before === undefined) {
			drift.push(`+ ${show(name, value)}${name.startsWith("PIN_") ? " (no part for it)" : ""}`)
			continue
		}
		const pin = name.startsWith("PIN_") ? pins.find((p) => macroName(p.signal) === name) : undefined
		const gpio = Number(value)
		if (pin && Number.isInteger(gpio) && gpio >= 0) {
			mapped.push(`${pin.signal} GPIO${pin.gpio} → GPIO${gpio}`)
			pin.gpio = gpio
		} else {
			drift.push(`${show(name, before)} → ${value}`)
		}
	}
	for (const [name, value] of was.defines) {
		if (!now.defines.has(name)) drift.push(`- ${show(name, value)}${name.startsWith("PIN_") ? " (removing a pin isn't mapped)" : ""}`)
	}
	for (const line of now.other) if (!was.other.includes(line)) drift.push(`+ ${line}`)
	for (const line of was.other) if (!now.other.includes(line)) drift.push(`- ${line}`)
	return { mapped, pins: mapped.length > 0 ? pins : null, drift }
}

export type FileSync = Human & { close(): void }

// The plain-code participant behind it. It watches <outDir> (recursively), handles a generated file only once its
// build has finished (so the builder's own writes are never mistaken for edits), and stops on run.ended.
export function createFileSync(opts: { outDir: string; debounceMs?: number }): FileSync {
	const self = { id: "" }
	const built = new Set<number>()
	const seen = new Map<string, string>()
	const timers = new Map<string, NodeJS.Timeout>()
	let watcher: FSWatcher | null = null

	const drift = (p: Payloads["file.drift"]) => emit(makeEvent("file.drift", self.id, p), self.id)

	const handle = (rel: string) => {
		const m = PINS_H.exec(rel)
		if (!m) return
		const revision = Number(m[1])
		if (!built.has(revision)) return
		let text: string
		try {
			text = readFileSync(join(opts.outDir, rel), "utf8")
		} catch {
			return
		}
		if (seen.get(rel) === text) return
		seen.set(rel, text)
		const contract = state().contract
		const at = contract.snapshotAt(revision)
		if (!at) return
		const generated = pinsHeader(at)
		if (text === generated) return
		const edits = pinsEdits(text, generated, at)
		const now = contract.snapshot()
		// Stale: a field the firmware is built from changed since this file was generated (a later outline change
		// doesn't make the newest pins.h stale).
		if (BUILD_INPUTS.firmware.some((f) => at.versions[f] !== now.versions[f])) {
			return drift({ path: rel, savedRevision: revision, designRevision: now.revision, reason: "stale", items: [...edits.mapped, ...edits.drift], message: `saved against rev ${revision}, the design is at rev ${now.revision}` })
		}
		if (edits.mapped.length > 0) {
			const source: FileSource = { kind: "file", path: rel, revision, items: edits.mapped }
			appendRequest(opts.outDir, `edited pins.h: ${edits.mapped.join("; ")}`, source)
		}
		if (edits.drift.length > 0) drift({ path: rel, savedRevision: revision, designRevision: now.revision, reason: "not-in-contract", items: edits.drift, message: DRIFT_MESSAGE })
	}

	const close = () => {
		watcher?.close()
		watcher = null
		for (const t of timers.values()) clearTimeout(t)
		timers.clear()
	}

	try {
		watcher = watch(opts.outDir, { recursive: true }, (_, name) => {
			const rel = String(name ?? "").replaceAll("\\", "/")
			if (!PINS_H.test(rel)) return
			clearTimeout(timers.get(rel))
			timers.set(rel, setTimeout(() => {
				timers.delete(rel)
				try {
					handle(rel)
				} catch (error) {
					console.error("[files] could not handle a saved file:", error)
				}
			}, opts.debounceMs ?? DEBOUNCE_MS))
		})
	} catch (error) {
		console.error("[files] cannot watch the output folder; edits to generated files won't sync:", error)
	}

	const participant = createHuman({
		name: "files",
		capabilities: [],
		handlers: [
			{
				specification: { isSatisfiedBy: () => true } as never,
				processor: {
					apply: ({ event }) => {
						if ((isEvent(event, "artifact.ready") || isEvent(event, "artifact.failed")) && event.payload.kind === "firmware") built.add(event.payload.revision)
						if (isEvent(event, "run.ended")) close()
					},
				},
			},
		],
	})
	self.id = participant.getId()
	return Object.assign(participant, { close })
}
