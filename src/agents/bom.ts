import { renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createHuman, type Human } from "@mozaik-ai/core"
import { isEvent } from "../events.ts"
import { state } from "../runtime.ts"
import { when } from "../change-control.ts"
import { searchParts } from "../tools/parts-search.ts"
import { alternativesFor, orderReadiness, sourcesFor, type Alternative, type Readiness, type Source } from "../tools/sourcing.ts"

export interface BomItem {
	ref: string
	role: string
	mpn: string
	lcsc: string | null
	footprint: string
	stock: number | null
	priceUsd: number | null
	inStock: boolean | null
	grounded: boolean
	finding?: string
	// Where to buy it: LCSC with live data, other suppliers as unchecked search links (tools/sourcing.ts).
	sources?: Source[]
	// Other catalog parts with the same role.
	alternatives?: Alternative[]
}

export interface Bom {
	revision: number
	// Sum of the parts that could be priced; null when none could be (offline).
	totalUsd: number | null
	items: BomItem[]
	// Whether one LCSC/JLCPCB order covers every line, and why not.
	readiness?: Readiness
}

// Plain-code participant behind the dashboard's parts panel: on a parts change or a grounding result it writes
// <outDir>/bom.json with live stock and price per part and whether the grounding check backs it. Writes are
// debounced and run off the event path, so the outbox never waits on the network.
export function createBomWriter(opts: { fetch?: typeof fetch; debounceMs?: number; root?: string } = {}): Human & { writes: number } {
	const debounceMs = opts.debounceMs ?? 400
	let timer: NodeJS.Timeout | null = null
	let running: Promise<void> | null = null
	let again = false
	const counter = { writes: 0 }

	const write = async () => {
		const s = state()
		const snapshot = s.contract.snapshot()
		const parts = snapshot.values.parts ?? []
		const findings = s.groundingFindings
		const live = new Map<string, Awaited<ReturnType<typeof searchParts>>>()
		for (const role of new Set(parts.map((p) => p.role))) live.set(role, await searchParts(role, { fetch: opts.fetch, root: opts.root }))
		const items: BomItem[] = parts.map((p) => {
			const hit = p.lcsc ? live.get(p.role)?.find((c) => c.lcsc === p.lcsc) : undefined
			const finding = findings.find((f) => f.partRef === p.ref)
			const roleParts = live.get(p.role) ?? []
			return {
				ref: p.ref,
				role: p.role,
				mpn: p.mpn,
				lcsc: p.lcsc,
				footprint: p.footprint,
				stock: hit?.stock ?? null,
				priceUsd: hit?.priceUsd ?? null,
				inStock: hit?.inStock ?? null,
				grounded: !finding,
				...(finding ? { finding: finding.detail } : {}),
				sources: sourcesFor(p, hit),
				// The same per-role lookup feeds the alternatives, so they cost no extra requests.
				alternatives: alternativesFor(p, roleParts),
			}
		})
		const priced = items.filter((i) => i.priceUsd !== null)
		const bom: Bom = {
			revision: snapshot.revision,
			totalUsd: priced.length > 0 ? Math.round(priced.reduce((sum, i) => sum + i.priceUsd!, 0) * 1e4) / 1e4 : null,
			items,
			readiness: orderReadiness(items),
		}
		// Write then rename, so the page never reads half a file.
		const path = join(s.outDir, "bom.json")
		writeFileSync(`${path}.tmp`, JSON.stringify(bom, null, 2))
		renameSync(`${path}.tmp`, path)
		counter.writes++
	}

	// One write at a time; a request during a write runs once more afterwards.
	const flush = () => {
		timer = null
		if (running) {
			again = true
			return
		}
		running = write()
			.catch((error) => console.error("[bom] write failed:", error instanceof Error ? error.message : error))
			.finally(() => {
				running = null
				if (again) {
					again = false
					flush()
				}
			})
	}
	const schedule = () => {
		if (timer) clearTimeout(timer)
		timer = setTimeout(flush, debounceMs)
	}

	const participant = createHuman({
		name: "bom",
		capabilities: [],
		handlers: [
			{
				specification: when(({ event }) => (isEvent(event, "contract.changed") && event.payload.field === "parts") || isEvent(event, "grounding.checked")),
				processor: { apply: () => schedule() },
			},
		],
	})
	return Object.defineProperty(participant, "writes", { get: () => counter.writes }) as Human & { writes: number }
}
