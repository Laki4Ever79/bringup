import { closeSync, mkdirSync, openSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { Budget, BudgetExhausted } from "./budget.ts"
import { learnedDir, learnedFileName, readLearned, writeLearned } from "./catalog.ts"
import { docNamesPart, findListings, sameMpn, type Distributor, type webFind } from "./distributors.ts"
import type { DocStore } from "./docs.ts"
import { extractFacts, identifyPart, type ClaimTrace } from "./extract.ts"
import { loadKinds, type KindFile } from "./kinds.ts"
import type { PageReader, ReadRequest } from "./reader.ts"
import { completeFacts, judge } from "./rule.ts"
import type { Candidate, Fact, LearnedDoc, LearnedPart, Listing, PartNeed } from "./types.ts"

export type LearnResult = { status: "learned"; part: LearnedPart; reused: boolean } | { status: "unavailable"; reasons: { mpn: string; reason: string }[] }

// One line per candidate tried, in the plan's learn.jsonl: what it cost and how well the cheap model read it, which is
// what tunes the model choice. firstReadMatched: facts the cheap model's first read gave that were confirmed without the
// strong model, counted for every candidate, learned or not.
export interface LearnLog {
	need: string
	mpn: string
	pages: number
	calls: number
	models: string[]
	usd: number
	firstReadMatched: number
	facts: number
	outcome: "learned" | string
}

export interface LearnDeps {
	// Where learned parts are written (catalog/learned/ under it), and where the kind files are read (kindsRoot, by
	// default the same). Mock runs write under the plan's folder, never into the real catalog.
	root: string
	kindsRoot?: string
	store: DocStore
	reader: PageReader
	budget: Budget
	distributors: Distributor[]
	webFind: (mpn: string) => ReturnType<typeof webFind>
	footprint: (part: { mpn: string; lcsc?: string; packageName?: string; pins: string[]; bodyMm?: number[] }) => Promise<Fact | null>
	// Candidates for a need, each with the datasheet link the proposer found, if any (a bare part number works too).
	propose: (need: PartNeed, exclude: string[]) => Promise<(string | Candidate)[]>
	log: (line: LearnLog) => void
	// Every claim a model makes and how it was checked (the plan's claims.jsonl).
	onClaim?: (t: ClaimTrace & { need: string; mpn: string }) => void
}

const MAX_CANDIDATES = 3
const LOCK_POLL_MS = 250
const LOCK_WAIT_MS = 10 * 60_000
// A lock older than this belongs to a learner that died; it is taken over.
const LOCK_STALE_MS = 15 * 60_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const learnedMpn = (root: string, mpn: string) => readLearned(root).find((p) => sameMpn(p.mpn, mpn)) ?? null

// One learner per MPN at a time, across runs: an exclusive lock file. Returns a release function, or the part another
// learner finished while this one waited.
async function lockMpn(root: string, mpn: string): Promise<{ release: () => void } | { learned: LearnedPart }> {
	const dir = join(learnedDir(root), ".locks")
	mkdirSync(dir, { recursive: true })
	const file = join(dir, `${learnedFileName(mpn)}.lock`)
	const until = Date.now() + LOCK_WAIT_MS
	for (;;) {
		try {
			closeSync(openSync(file, "wx"))
			return { release: () => rmSync(file, { force: true }) }
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
		}
		const done = learnedMpn(root, mpn)
		if (done) return { learned: done }
		try {
			if (Date.now() - statSync(file).mtimeMs > LOCK_STALE_MS) rmSync(file, { force: true })
		} catch {
			// Released between the two calls: try again.
		}
		if (Date.now() > until) throw new Error(`waited ${LOCK_WAIT_MS / 60_000} min for another learner of ${mpn}`)
		await sleep(LOCK_POLL_MS)
	}
}

// Counts one candidate's model calls, models and strong reads, for its log line.
function counting(inner: PageReader) {
	const stats = { calls: 0, strong: 0, models: new Set<string>() }
	const reader: PageReader = {
		async read(req: ReadRequest) {
			stats.calls++
			stats.models.add(req.model)
			if (req.meta.pass === "strong") stats.strong++
			return inner.read(req)
		},
	}
	return { reader, stats }
}

// Facts from a second document fill only fields the first didn't give.
const merge = (a: Fact[], b: Fact[]) => [...a, ...b.filter((f) => !a.some((x) => x.field === f.field))]

type Tried = { ok: true; part: LearnedPart; good: boolean } | { ok: false; reason: string }

async function tryCandidate({ mpn, datasheetUrl }: Candidate, need: PartNeed, kind: KindFile, deps: LearnDeps): Promise<Tried & { stats: ReturnType<typeof counting>["stats"]; pages: number; facts: number; usd: number; firstRead: number }> {
	const { reader, stats } = counting(deps.reader)
	const spentBefore = deps.budget.spent
	const read = { firstRead: 0, pages: 0 }
	let facts: Fact[] = []
	const end = (t: Tried) => ({ ...t, stats, pages: read.pages, facts: facts.length, usd: deps.budget.spent - spentBefore, firstRead: read.firstRead })

	const listings: Listing[] = await findListings(mpn, deps.distributors)
	// Datasheet links: the distributors' first, then the manufacturer's (found by web search) if none of them works.
	const urls = [...new Set(listings.map((l) => l.datasheetUrl).filter((u): u is string => Boolean(u)))]
	const docs: LearnedDoc[] = []
	const fetchFirst = async (list: string[]) => {
		for (const url of list) {
			const d = await deps.store.fetch(url, "datasheet")
			if (!("error" in d) && !docs.some((x) => x.sha256 === d.sha256)) return d
		}
		return null
	}
	// The proposer's own link first, but only if the PDF names this part: a series sheet for another variant is not it.
	let doc: LearnedDoc | null = null
	if (datasheetUrl && !urls.includes(datasheetUrl)) {
		const d = await deps.store.fetch(datasheetUrl, "datasheet")
		if (!("error" in d) && (await docNamesPart(mpn, d, deps.store))) {
			doc = d
			listings.push({ distributor: "manufacturer", mpn, stock: null, priceUsd: null, assemblerStocked: false, datasheetUrl })
		}
	}
	doc ??= await fetchFirst(urls)
	let searched = "not tried"
	if (!doc) {
		const found = await deps.webFind(mpn)
		if (found && "missed" in found) searched = found.missed
		else if (found?.datasheetUrl) {
			listings.push(found)
			doc = await fetchFirst([found.datasheetUrl])
			if (!doc) searched = "its link didn't open"
		} else searched = "nothing"
	}
	if (!doc) {
		const listed = urls.length ? `${urls.length} distributor link${urls.length === 1 ? "" : "s"} didn't open` : listings.length ? "distributor listings without a datasheet link" : "no distributor listing"
		return end({ ok: false, reason: `no datasheet found (${listed}; web search: ${searched})` })
	}
	docs.push(doc)
	const id = await identifyPart(doc, kind, mpn, { store: deps.store, reader })
	if (!id.matches) return end({ ok: false, reason: `the datasheet is for ${id.part ?? "another kind of part"}, not ${kind.description ?? `a ${kind.kind}`}` })
	let found = await extractFacts(doc, kind, { store: deps.store, reader, mpn, stats: read, onClaim: (t) => deps.onClaim?.({ need: need.id, mpn, ...t }) })

	const addFootprint = async () => {
		if (kind.placement !== "board" || found.some((f) => f.field === "footprint")) return
		const pins = found.find((f) => f.field === "pins")?.value
		const pkg = found.find((f) => f.field === "package")?.value
		const lcscListing = listings.find((l) => l.distributor === "lcsc")
		const outline = found.find((f) => f.field === "outline")?.value
		const bodyMm = Array.isArray(outline) ? outline : typeof outline === "number" ? [outline] : undefined
		const fp = await deps.footprint({ mpn, lcsc: lcscListing?.sku, packageName: listings.find((l) => l.package)?.package ?? (typeof pkg === "string" ? pkg : undefined), pins: typeof pins === "string" ? pins.split(",").map((p) => p.trim()).filter(Boolean) : [], ...(bodyMm ? { bodyMm } : {}) })
		if (fp) found.push(fp)
	}
	await addFootprint()
	facts = completeFacts(found, kind)
	let verdict = judge(facts, kind)
	// Missing a critical fact: one more document (another distributor's datasheet link) before giving up on this part.
	if (!verdict.ok) {
		const other = await fetchFirst(urls.filter((u) => u !== doc.url))
		if (other) {
			docs.push(other)
			found = merge(found, await extractFacts(other, kind, { store: deps.store, reader, mpn, stats: read, onClaim: (t) => deps.onClaim?.({ need: need.id, mpn, ...t }) }))
			await addFootprint()
			facts = completeFacts(found, kind)
			verdict = judge(facts, kind)
		}
	}
	if (!verdict.ok) return end({ ok: false, reason: `missing critical: ${verdict.missingCritical.join(", ")}` })

	const part: LearnedPart = {
		mpn: listings.find((l) => sameMpn(l.mpn, mpn))?.mpn ?? mpn,
		role: need.role,
		kind: kind.kind,
		placement: kind.placement,
		facts,
		documents: docs,
		orderFrom: listings,
		...(listings.find((l) => l.photoUrl) ? { photo: { url: listings.find((l) => l.photoUrl)!.photoUrl!, sha256: "" } } : {}),
		learnedAt: new Date().toISOString(),
		learner: [...stats.models],
		costUsd: Number((deps.budget.spent - spentBefore).toFixed(4)),
	}
	const inStock = listings.some((l) => (l.stock ?? 0) > 0)
	const good = inStock && (kind.placement === "case" || listings.some((l) => l.assemblerStocked))
	return end({ ok: true, part, good })
}

// Ranking among learned candidates: in stock, then placeable by the assembler (board parts), then cheaper.
function rank(p: LearnedPart): [number, number, number] {
	const inStock = p.orderFrom.some((l) => (l.stock ?? 0) > 0) ? 0 : 1
	const assembler = p.placement === "board" && !p.orderFrom.some((l) => l.assemblerStocked) ? 1 : 0
	const prices = p.orderFrom.map((l) => l.priceUsd).filter((x): x is number => x !== null)
	return [inStock, assembler, prices.length ? Math.min(...prices) : Number.POSITIVE_INFINITY]
}
const better = (a: LearnedPart, b: LearnedPart) => {
	const [x, y] = [rank(a), rank(b)]
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i]
	return false
}

// Learns the part a plan needs: up to three candidates, each by its datasheet; the first that is complete, in stock
// and (on the board) assembler-stocked wins at once, otherwise the best complete one. Only the winner is written to
// catalog/learned/. The spending cap reached anywhere ends it with nothing written.
export async function learnPart(need: PartNeed, deps: LearnDeps): Promise<LearnResult> {
	const kind = loadKinds(deps.kindsRoot ?? deps.root).get(need.kind)
	if (!kind) return { status: "unavailable", reasons: [{ mpn: "", reason: `no kind file for "${need.kind}"` }] }
	const reasons: { mpn: string; reason: string }[] = []
	let best: LearnedPart | null = null
	let current = ""
	try {
		const candidates = (await deps.propose(need, [])).slice(0, MAX_CANDIDATES).map((c): Candidate => (typeof c === "string" ? { mpn: c } : c))
		for (const candidate of candidates) {
			const mpn = candidate.mpn
			current = mpn
			const existing = learnedMpn(deps.root, mpn)
			if (existing) return { status: "learned", part: existing, reused: true }
			const lock = await lockMpn(deps.root, mpn)
			if ("learned" in lock) return { status: "learned", part: lock.learned, reused: true }
			try {
				// Another learner may have finished between the check and the lock.
				const now = learnedMpn(deps.root, mpn)
				if (now) return { status: "learned", part: now, reused: true }
				const t = await tryCandidate(candidate, need, kind, deps).catch((e) => {
					// The cap ends the whole need; any other error (a provider outage, a broken PDF) ends only this candidate.
					if (e instanceof BudgetExhausted) throw e
					return { ok: false as const, reason: `failed: ${e instanceof Error ? e.message : e}`, stats: { calls: 0, strong: 0, models: new Set<string>() }, pages: 0, facts: 0, usd: 0, firstRead: 0 }
				})
				deps.log({ need: need.id, mpn, pages: t.pages, calls: t.stats.calls, models: [...t.stats.models], usd: Number(t.usd.toFixed(4)), firstReadMatched: t.firstRead, facts: t.facts, outcome: t.ok ? "learned" : t.reason })
				if (!t.ok) {
					reasons.push({ mpn, reason: t.reason })
					continue
				}
				if (t.good) {
					writeLearned(deps.root, t.part)
					return { status: "learned", part: t.part, reused: false }
				}
				if (!best || better(t.part, best)) best = t.part
				reasons.push({ mpn, reason: "learned, but not in stock or not placeable by the assembler" })
			} finally {
				lock.release()
			}
		}
	} catch (e) {
		if (e instanceof BudgetExhausted) return { status: "unavailable", reasons: [...reasons, { mpn: current, reason: "spending cap reached" }] }
		throw e
	}
	if (best) {
		writeLearned(deps.root, best)
		return { status: "learned", part: best, reused: false }
	}
	return { status: "unavailable", reasons: reasons.length ? reasons : [{ mpn: "", reason: "no candidate part proposed" }] }
}
