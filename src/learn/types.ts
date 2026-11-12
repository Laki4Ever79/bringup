// The part learner's records (docs/superpowers/specs/2026-11-12-part-learner-design.md): a part Bringup learned by
// itself, every number with where it came from.

// "datasheet": read from a document and confirmed (by its text, or two agreeing reads of an image-only page).
// "calculated": from other facts by a named formula. "default": not found anywhere; the kind's stated default.
export type FactStatus = "datasheet" | "calculated" | "default"

// Where a number was read: a document, a page (1-based) and the region on it as page fractions [x, y, w, h], from the
// top left. `quote` is the text as written there ("Ø2.2", "2.5 ~ 5.5V").
export interface SourceRef {
	doc: string
	page: number
	region: [number, number, number, number]
	quote: string
}

export interface Fact {
	field: string
	value: number | string | number[]
	unit?: string
	status: FactStatus
	critical: boolean
	source?: SourceRef
	formula?: string
	inputs?: string[]
	// Why a default was used.
	reason?: string
	// How a "datasheet" fact was confirmed: its text in the region, two agreeing model reads (image-only page), the
	// drawing overlay (plan 3), or (a footprint) a library land pattern whose pad count matches the pins.
	check?: "text" | "two-reads" | "overlay" | "pad-count"
	// Where a fact came from when it isn't a page of a document: the library footprint's URL or name.
	origin?: string
}

export interface LearnedDoc {
	id: string
	url: string
	sha256: string
	pages: number
	fetchedAt: string
	kind: "datasheet" | "drawing" | "step" | "distributor"
}

// One distributor's (or the manufacturer's) offer of a part. assemblerStocked: the board assembler (JLCPCB) stocks it,
// so it can be placed by machine.
export interface Listing {
	distributor: string
	mpn: string
	manufacturer?: string
	sku?: string
	stock: number | null
	priceUsd: number | null
	assemblerStocked: boolean
	datasheetUrl?: string
	photoUrl?: string
	productUrl?: string
	// The package as the distributor names it ("SOT-25"), and its one-line description: hints for the footprint search.
	package?: string
	description?: string
}

export interface LearnedPart {
	mpn: string
	role: string
	kind: string
	placement: "board" | "case"
	facts: Fact[]
	documents: LearnedDoc[]
	orderFrom: Listing[]
	photo?: { url: string; sha256: string }
	learnedAt: string
	// The model ids that read it.
	learner: string[]
	costUsd: number
}

// A part a plan needs and the catalog lacks: a role on a board, the kind of part, and what it must do in words.
export interface PartNeed {
	id: string
	role: string
	kind: string
	requirements: string
	board?: string
}
