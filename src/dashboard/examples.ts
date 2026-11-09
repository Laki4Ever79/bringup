import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// Finished runs shipped in the repo for the start screen, trimmed to what the viewer reads (spec §1). A system run
// keeps its boards and links; a single board run becomes a one-board example named "main".

// The circuit element types pcb-view.js and scene3d.js read; the rest (schematic, silkscreen, paste…) is dropped.
const VIEWER_TYPES = new Set(["pcb_board", "pcb_component", "pcb_plated_hole", "pcb_port", "pcb_smtpad", "pcb_trace", "pcb_via", "source_component", "source_net", "source_port", "source_trace"])
const CASE_FILES = ["case.stl", "lid.stl", "spec.json", "standoffs.json"]

export interface ExampleMeta {
	name: string
	sentence: string
	title: string
	boards: { name: string; outline: { widthMm: number; heightMm: number } | null }[]
	links: unknown[]
}

const readJson = (path: string) => {
	try {
		return JSON.parse(readFileSync(path, "utf8"))
	} catch {
		return null
	}
}

function lastEnclosure(boardDir: string): string | null {
	const root = join(boardDir, "enclosure")
	if (!existsSync(root)) return null
	const revs = readdirSync(root).map((n) => /^rev-(\d+)$/.exec(n)?.[1]).filter((n): n is string => n !== undefined).map(Number).sort((a, b) => a - b)
	return revs.length ? join(root, `rev-${revs.at(-1)}`) : null
}

function saveBoard(from: string, to: string): ExampleMeta["boards"][number]["outline"] {
	mkdirSync(to, { recursive: true })
	const contract = readJson(join(from, "contract.json"))
	if (contract) writeFileSync(join(to, "contract.json"), JSON.stringify(contract))
	const circuit = readJson(join(from, "board", "circuit.json"))
	if (Array.isArray(circuit)) writeFileSync(join(to, "circuit.json"), JSON.stringify(circuit.filter((e: { type?: string }) => VIEWER_TYPES.has(e.type ?? ""))))
	if (existsSync(join(from, "board", "board.png"))) copyFileSync(join(from, "board", "board.png"), join(to, "board.png"))
	const enc = lastEnclosure(from)
	for (const f of CASE_FILES) if (enc && existsSync(join(enc, f))) copyFileSync(join(enc, f), join(to, f))
	const o = contract?.values?.outline
	return o ? { widthMm: o.widthMm, heightMm: o.heightMm } : null
}

export function saveExample(sourceDir: string, name: string, sentence: string, destRoot = "examples", titleOverride?: string): ExampleMeta {
	if (!/^[\w-]+$/.test(name)) throw new Error("an example name is letters, digits, - and _")
	const dest = join(destRoot, name)
	// The still (the start screen's first frame, saved by hand from the browser) survives a re-save.
	const still = existsSync(join(dest, "still.png")) ? readFileSync(join(dest, "still.png")) : null
	rmSync(dest, { recursive: true, force: true })
	mkdirSync(dest, { recursive: true })
	if (still) writeFileSync(join(dest, "still.png"), still)
	const spec = readJson(join(sourceDir, "system.json"))
	const boards: ExampleMeta["boards"] = []
	if (spec) for (const b of spec.boards as { name: string }[]) boards.push({ name: b.name, outline: saveBoard(join(sourceDir, "boards", b.name), join(dest, "boards", b.name)) })
	else boards.push({ name: "main", outline: saveBoard(sourceDir, join(dest, "boards", "main")) })
	const brief = existsSync(join(sourceDir, "brief.md")) ? readFileSync(join(sourceDir, "brief.md"), "utf8") : ""
	const title = titleOverride ?? spec?.name ?? (brief.split("\n").find((l) => l.trim()) ?? name).replace(/^#+\s*/, "").replace(/^Brief:\s*/i, "").trim()
	const meta: ExampleMeta = { name, sentence, title, boards, links: spec?.links ?? [] }
	writeFileSync(join(dest, "example.json"), JSON.stringify(meta, null, "\t"))
	return meta
}

export function listExamples(root: string): ExampleMeta[] {
	if (!existsSync(root)) return []
	return readdirSync(root)
		.sort()
		.map((n) => readJson(join(root, n, "example.json")) as ExampleMeta | null)
		.filter((m): m is ExampleMeta => m !== null)
}

// A file inside one example, or null: every segment is a plain name, so nothing outside the folder can be named.
export function exampleFile(root: string, rel: string): string | null {
	const parts = rel.split("/")
	if (parts.length < 2 || !/^[\w-]+$/.test(parts[0]) || parts.some((p) => !/^[\w][\w.-]*$/.test(p) || p.includes(".."))) return null
	const path = join(root, ...parts)
	return existsSync(path) ? path : null
}
