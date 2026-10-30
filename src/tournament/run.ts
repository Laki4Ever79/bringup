import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { startRunProcess, type RunExit, type RunProcess, type RunProcessArgs } from "../runner/spawn-run.ts"
import { rankRows, scoreboardMarkdown, scoreRun, type RunRecord, type ScoreRow } from "./score.ts"

export interface Variant {
	name: string
	// Appended to the brief; empty for the baseline.
	constraint: string
}

export interface TournamentOptions {
	briefPath: string
	variants: Variant[]
	mock: boolean
	outRoot: string
	onFinished?: (variant: string, exit: RunExit, done: number, total: number) => void
	start?: (args: RunProcessArgs) => RunProcess
}

export interface Scoreboard {
	brief: string
	mock: boolean
	rows: ScoreRow[]
}

export function variantSlug(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "variant"
}

export function variantBrief(brief: string, v: Variant): string {
	return v.constraint ? `${brief.trimEnd()}\n\n## Tournament variant: ${v.name}\n\n${v.constraint}\n` : brief
}

// Runs every variant of one brief at the same time, each as its own design process (one Mozaik runtime per
// process), then scores and ranks them. Writes <outRoot>/<variant>/ per run and scoreboard.json/.md at the top.
export async function runTournament(opts: TournamentOptions): Promise<Scoreboard> {
	const brief = readFileSync(opts.briefPath, "utf8")
	const slugs = opts.variants.map((v) => variantSlug(v.name))
	if (new Set(slugs).size !== slugs.length) throw new Error(`variant names must be distinct: ${opts.variants.map((v) => v.name).join(", ")}`)
	const start = opts.start ?? ((args) => startRunProcess(args))
	let done = 0

	const runs = opts.variants.map(async (v, i) => {
		const dir = join(opts.outRoot, slugs[i])
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, "brief.md"), variantBrief(brief, v))
		writeFileSync(join(dir, "variant.json"), JSON.stringify(v, null, 2))
		const startedAt = new Date().toISOString()
		const exit = await start({ briefPath: join(dir, "brief.md"), mock: opts.mock, outDir: dir }).done
		const record: RunRecord = { startedAt, endedAt: new Date().toISOString(), exitCode: exit.code }
		writeFileSync(join(dir, "run.json"), JSON.stringify(record, null, 2))
		if (exit.code !== 0) writeFileSync(join(dir, "run.log"), `${exit.stdout}\n--- stderr ---\n${exit.stderr}`)
		opts.onFinished?.(v.name, exit, ++done, opts.variants.length)
		return dir
	})
	const dirs = await Promise.all(runs)

	const rows = rankRows(await Promise.all(dirs.map((d) => scoreRun(d))))
	const board: Scoreboard = { brief: opts.briefPath, mock: opts.mock, rows }
	writeFileSync(join(opts.outRoot, "scoreboard.json"), JSON.stringify(board, null, 2))
	writeFileSync(join(opts.outRoot, "scoreboard.md"), scoreboardMarkdown(rows))
	return board
}
