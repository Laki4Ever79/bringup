import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { Distributor } from "./distributors.ts"
import type { PageReader } from "./reader.ts"
import type { Fact, Listing, PartNeed } from "./types.ts"

// The part learner without models or network, for mock runs and --no-cloud: two fictional parts with datasheets we
// wrote (examples/learn/, built by its make.ts), and the answers a model would give reading them. Everything else (text
// checks, the missing-value rule, the catalog, the lock) runs for real.
const EXAMPLES = resolve(import.meta.dirname, "../../examples/learn")
const HOST = "https://example.invalid/learn"

type Region = [number, number, number, number]
type Answer = { value: unknown; unit?: string; region: Region }
type Script = Partial<Record<"first" | "second" | "strong", Record<number, Record<string, Answer>>>>

// A table row at y points (the value column) and a full-width text line, on a 612 × 792 pt page.
const row = (y: number): Region => [0.4, (y - 12) / 792, 0.4, 20 / 792]
const line = (y: number): Region => [0.05, (y - 14) / 792, 0.9, 24 / 792]

export const MOCK_SCRIPTS: Record<string, Script> = {
	amplifier: {
		first: {
			1: {
				supplyRange: { value: [2.5, 5.5], unit: "V", region: row(140) },
				supplyMaxV: { value: 6, unit: "V", region: row(160) },
				minLoadOhm: { value: 4, unit: "Ω", region: row(180) },
				outputPowerW: { value: 3.2, unit: "W", region: row(200) },
				quiescentMa: { value: 2.4, unit: "mA", region: row(220) },
				interface: { value: "I2S", region: row(240) },
			},
			2: {
				pins: { value: "1 SD, 2 GAIN, 3 DIN, 4 BCLK, 5 LRCLK, 6 GND, 7 VDD, 8 OUTP, 9 OUTN, 10 GND", region: line(90) },
				outline: { value: [3, 3], unit: "mm", region: line(130) },
				height: { value: 0.75, unit: "mm", region: line(130) },
			},
		},
	},
	// Page 2 of the speaker's datasheet is a drawing with no text layer: its facts need two agreeing reads.
	"speaker-driver": {
		first: {
			1: {
				impedanceOhm: { value: 8, unit: "Ω", region: row(120) },
				ratedPowerW: { value: 3, unit: "W", region: row(140) },
				vasL: { value: 0.12, unit: "L", region: row(160) },
				qts: { value: 0.85, region: row(180) },
				fsHz: { value: 650, unit: "Hz", region: row(200) },
				pins: { value: "+,-", region: line(220) },
			},
			2: {
				outline: { value: [40, 18.5], unit: "mm", region: [0.2, 0.3, 0.55, 0.4] },
				height: { value: 18.5, unit: "mm", region: [0.66, 0.36, 0.1, 0.14] },
				mountHoles: { value: "2 x 2.2 on 46", unit: "mm", region: [0.18, 0.42, 0.66, 0.06] },
			},
		},
		second: {
			2: {
				outline: { value: [40, 18.5], unit: "mm", region: [0.2, 0.3, 0.55, 0.4] },
				height: { value: 18.5, unit: "mm", region: [0.66, 0.36, 0.1, 0.14] },
				mountHoles: { value: "2 x 2.2 on 46", unit: "mm", region: [0.18, 0.42, 0.66, 0.06] },
			},
		},
	},
}

const MPN_BY_KIND: Record<string, string> = { amplifier: "BRG-AMP1", "speaker-driver": "BRG-SPK40" }
const FILE_BY_MPN: Record<string, string> = { "BRG-AMP1": "brg-amp1.pdf", "BRG-SPK40": "brg-spk40.pdf" }

// The kind is named in the prompt ('a part of kind "amplifier"'); the script answers by kind, pass and page.
export const mockReader: PageReader = {
	async read(req) {
		const kind = /kind "([^"]+)"/.exec(req.prompt)?.[1] ?? ""
		const page = MOCK_SCRIPTS[kind]?.[req.meta.pass as keyof Script]?.[req.meta.page] ?? {}
		return { json: { facts: req.meta.fields.filter((f) => page[f]).map((f) => ({ field: f, ...page[f], quote: String(page[f].value) })) }, usd: 0 }
	},
}

export const mockFetch = (async (input: string | URL | Request) => {
	const url = String(input instanceof Request ? input.url : input)
	const name = Object.values(FILE_BY_MPN).find((f) => url === `${HOST}/${f}`)
	return name ? new Response(readFileSync(join(EXAMPLES, name)), { status: 200, headers: { "content-type": "application/pdf" } }) : new Response("not found", { status: 404 })
}) as typeof fetch

export const mockDistributor: Distributor = {
	name: "mock",
	async lookup(mpn): Promise<Listing | null> {
		if (mpn === "BRG-AMP1") return { distributor: "lcsc", mpn, sku: "C999001", stock: 500, priceUsd: 0.42, assemblerStocked: true, datasheetUrl: `${HOST}/brg-amp1.pdf`, package: "QFN-10" }
		if (mpn === "BRG-SPK40") return { distributor: "mouser", mpn, sku: "000-BRGSPK40", stock: 120, priceUsd: 2.1, assemblerStocked: false, datasheetUrl: `${HOST}/brg-spk40.pdf` }
		return null
	},
}

export const mockPropose = async (need: PartNeed): Promise<string[]> => (MPN_BY_KIND[need.kind] ? [MPN_BY_KIND[need.kind]] : [])

// The amplifier's footprint as the EasyEDA search would find it (examples/learn/easyeda-c999001.json: 11 pads).
export const mockFootprint = async (p: { lcsc?: string; pins: string[] }): Promise<Fact | null> =>
	p.lcsc === "C999001" && (p.pins.length === 10 || p.pins.length === 11) ? { field: "footprint", value: "easyeda:C999001", status: "datasheet", critical: true, check: "pad-count", origin: "examples/learn/easyeda-c999001.json" } : null
