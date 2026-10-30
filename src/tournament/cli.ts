import "dotenv/config"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT } from "../run.ts"
import { runTournament, type Variant } from "./run.ts"
import { scoreboardMarkdown } from "./score.ts"

function usage(): never {
	console.error("usage: tsx src/tournament/cli.ts <brief.md> --variants <variants.json> [--mock] [--out <dir>]")
	process.exit(1)
}

const args = process.argv.slice(2)
const valueOf = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)
const briefPath = args.find((a, i) => !a.startsWith("--") && !["--variants", "--out"].includes(args[i - 1]))
const variantsPath = valueOf("--variants")
if (!briefPath || !existsSync(briefPath) || !variantsPath || !existsSync(variantsPath)) usage()

const variants = JSON.parse(readFileSync(variantsPath, "utf8")) as Variant[]
if (!Array.isArray(variants) || variants.length === 0 || !variants.every((v) => typeof v.name === "string" && typeof v.constraint === "string")) {
	console.error(`${variantsPath}: expected a non-empty array of {name, constraint}`)
	process.exit(1)
}
const mock = args.includes("--mock")
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)
const outRoot = valueOf("--out") ?? join(ROOT, "out", `tournament-${stamp}`)

console.log(`tournament: ${variants.length} variants of ${briefPath}, ${mock ? "mock models" : "real models"}, all at once\noutput: ${outRoot}`)
for (const v of variants) console.log(`  started  ${v.name}${v.constraint ? `: ${v.constraint}` : " (baseline)"}`)
const t0 = Date.now()
const board = await runTournament({
	briefPath,
	variants,
	mock,
	outRoot,
	onFinished: (name, exit, done, total) => {
		const outcome = exit.code === 0 ? "settled" : exit.code === 2 ? "UNSETTLED" : `FAILED (exit ${exit.code}, see run.log)`
		console.log(`  [${done}/${total}] ${name}: ${outcome} after ${Math.round((Date.now() - t0) / 1000)} s`)
	},
})
console.log(`\n${scoreboardMarkdown(board.rows)}\nscoreboard: ${join(outRoot, "scoreboard.md")}`)
process.exit(board.rows[0]?.settled ? 0 : 2)
