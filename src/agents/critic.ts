import { createHuman, type Human } from "@mozaik-ai/core"
import { groundParts, type GroundingFinding, type KicadSymbol } from "../contract/grounding.ts"
import type { ContractSnapshot } from "../contract/types.ts"
import { isEvent, makeEvent } from "../events.ts"
import { emit, state } from "../runtime.ts"
import { when } from "../change-control.ts"
import type { Env } from "../tools/env.ts"
import { loadSymbols } from "../tools/kicad-symbols.ts"
import { loadCatalog } from "../tools/parts-search.ts"
import { Rebuilder } from "../tools/rebuilder.ts"

export const SYMBOL_LIBRARIES = ["Sensor_Humidity", "Regulator_Linear", "MCU_Espressif", "RF_Module", "Sensor", "Connector"]

// Findings about a pin assignment (the architect's pins field) rather than the parts list. groundParts words
// assignment findings as "<SIGNAL> ..." and part-list findings as "<REF> lists pin ...".
export function isPinAssignmentFinding(f: GroundingFinding, s: ContractSnapshot): boolean {
	return (s.values.pins ?? []).some((a) => f.detail.startsWith(`${a.signal} `))
}

// A plain-code critic: whenever parts or pins change, it checks every claimed pin against the catalog and
// KiCad's symbol library and reports grounding.checked. Without KiCad it grounds in the catalog alone.
export function createCritic(env: Env): Human {
	const self = { id: "" }
	let symbols: Promise<Record<string, KicadSymbol> | undefined> | null = null
	const loadOnce = () =>
		(symbols ??= env.kicad
			? loadSymbols(env, SYMBOL_LIBRARIES).catch((error) => {
					console.error("[critic] KiCad symbols unavailable, grounding in the catalog only:", error instanceof Error ? error.message : error)
					return undefined
				})
			: Promise.resolve(undefined))
	const catalog = loadCatalog(env.root)

	const rebuilder = new Rebuilder(async () => {
		const snapshot = state().contract.snapshot()
		const grounded = { parts: snapshot.versions.parts, pins: snapshot.versions.pins }
		// Until a parts list exists, every pin assignment would read as "part not in the contract".
		if (!snapshot.values.parts) {
			state().groundedVersions = grounded
			return
		}
		const findings = groundParts(snapshot, { catalog, symbols: await loadOnce() })
		state().groundingFindings = findings
		state().groundedVersions = grounded
		emit(makeEvent("grounding.checked", self.id, { revision: snapshot.revision, findings }), self.id)
	})

	const critic = createHuman({
		name: "critic",
		capabilities: [],
		handlers: [
			{
				specification: when(({ event }) => isEvent(event, "contract.changed") && (event.payload.field === "parts" || event.payload.field === "pins")),
				processor: {
					apply: ({ event }) => {
						if (isEvent(event, "contract.changed")) rebuilder.request(event.payload.revision)
					},
				},
			},
		],
	})
	self.id = critic.getId()
	state().criticEnabled = true
	return Object.assign(critic, { rebuilder })
}
