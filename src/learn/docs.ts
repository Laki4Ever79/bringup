import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import type { LearnedDoc, SourceRef } from "./types.ts"

const run = promisify(execFile)

// Datasheets and drawings, fetched once and kept in a local cache (.cache/learn/, gitignored: they are the
// manufacturers' copyright). Pages are read with poppler (pdfinfo, pdftotext, pdftoppm).
export interface DocStore {
	fetch(url: string, kind: LearnedDoc["kind"]): Promise<LearnedDoc | { error: string }>
	path(doc: LearnedDoc): string
	renderPage(doc: LearnedDoc, page: number, dpi?: number): Promise<Buffer>
	// The page's text, or only the text inside a region (page fractions [x, y, w, h] from the top left). "" when the
	// page (or region) has no text layer: an image-only page.
	textIn(doc: LearnedDoc, page: number, region?: SourceRef["region"]): Promise<string>
}

const MAX_BYTES = 30 * 1024 * 1024
const TIMEOUT_MS = 30_000

export function createDocStore(root: string, fetchImpl: typeof fetch = fetch): DocStore {
	const dir = join(root, ".cache/learn")
	const indexFile = join(dir, "urls.json")
	const readIndex = (): Record<string, LearnedDoc> => {
		try {
			return JSON.parse(readFileSync(indexFile, "utf8"))
		} catch {
			return {}
		}
	}
	const path = (doc: LearnedDoc) => join(dir, `${doc.sha256}.pdf`)
	const sizes = new Map<string, { w: number; h: number }[]>()

	async function pageSizes(doc: LearnedDoc): Promise<{ w: number; h: number }[]> {
		const known = sizes.get(doc.sha256)
		if (known) return known
		const { stdout } = await run("pdfinfo", ["-f", "1", "-l", String(doc.pages), path(doc)])
		const out = [...stdout.matchAll(/^Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+)/gm)].map((m) => ({ w: Number(m[2]), h: Number(m[3]) }))
		sizes.set(doc.sha256, out)
		return out
	}

	return {
		path,
		async fetch(url, kind) {
			const cached = readIndex()[url]
			if (cached && existsSync(path(cached))) return { ...cached, kind }
			let bytes: Buffer
			try {
				const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "follow" })
				if (!res.ok) return { error: `${url}: HTTP ${res.status}` }
				const declared = Number(res.headers.get("content-length") ?? 0)
				if (declared > MAX_BYTES) return { error: `${url}: larger than ${MAX_BYTES / 1024 / 1024} MB` }
				bytes = Buffer.from(await res.arrayBuffer())
				if (bytes.length > MAX_BYTES) return { error: `${url}: larger than ${MAX_BYTES / 1024 / 1024} MB` }
				if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return { error: `${url}: not a PDF (got ${res.headers.get("content-type") ?? "unknown type"})` }
			} catch (e) {
				return { error: `${url}: ${e instanceof Error ? e.message : e}` }
			}
			const sha256 = createHash("sha256").update(bytes).digest("hex")
			mkdirSync(dir, { recursive: true })
			const file = join(dir, `${sha256}.pdf`)
			if (!existsSync(file)) writeFileSync(file, bytes)
			let pages: number
			try {
				const { stdout } = await run("pdfinfo", [file])
				pages = Number(/^Pages:\s+(\d+)/m.exec(stdout)?.[1] ?? 0)
			} catch (e) {
				return { error: `${url}: unreadable PDF (${e instanceof Error ? e.message : e})` }
			}
			if (!pages) return { error: `${url}: a PDF with no pages` }
			const doc: LearnedDoc = { id: sha256.slice(0, 12), url, sha256, pages, fetchedAt: new Date().toISOString(), kind }
			const index = readIndex()
			index[url] = doc
			const tmp = `${indexFile}.${process.pid}.tmp`
			writeFileSync(tmp, JSON.stringify(index, null, "\t"))
			renameSync(tmp, indexFile)
			return doc
		},
		async renderPage(doc, page, dpi = 110) {
			const { stdout } = await run("pdftoppm", ["-png", "-r", String(dpi), "-f", String(page), "-l", String(page), "-singlefile", path(doc)], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 })
			return stdout
		},
		async textIn(doc, page, region) {
			const args = ["-layout", "-f", String(page), "-l", String(page), "-r", "72"]
			if (region) {
				const size = (await pageSizes(doc))[page - 1] ?? { w: 612, h: 792 }
				const [x, y, w, h] = region
				// At 72 dpi pdftotext's crop box is in points.
				args.push("-x", String(Math.floor(x * size.w)), "-y", String(Math.floor(y * size.h)), "-W", String(Math.ceil(w * size.w)), "-H", String(Math.ceil(h * size.h)))
			}
			const { stdout } = await run("pdftotext", [...args, path(doc), "-"])
			return stdout.replace(/\f/g, "").trim()
		},
	}
}

// For `npm run doctor`: are poppler's tools on PATH?
export async function popplerAvailable(): Promise<Record<"pdfinfo" | "pdftotext" | "pdftoppm", boolean>> {
	const has = async (cmd: string) =>
		run(cmd, ["-v"]).then(
			() => true,
			(e: { code?: string }) => e.code !== "ENOENT",
		)
	const [a, b, c] = await Promise.all([has("pdfinfo"), has("pdftotext"), has("pdftoppm")])
	return { pdfinfo: a, pdftotext: b, pdftoppm: c }
}
