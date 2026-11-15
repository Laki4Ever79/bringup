// npx tsx scripts/save-starter.ts <brief.md | system spec.json> <example name> "<why>" [--robot]
// Writes examples/<name>/starter.json, the seed plan a fork copies (src/dashboard/starters.ts). The sentence is the
// example's own (example.json); a system spec's boards bring their briefs, read relative to the spec.
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { starterSeed } from "../src/dashboard/starters.ts"
import type { SystemSpec } from "../src/system/spec.ts"

const args = process.argv.slice(2)
const robot = args.includes("--robot")
const [source, name, why] = args.filter((a) => a !== "--robot")
if (!source || !name || !why) {
	console.error('usage: npx tsx scripts/save-starter.ts <brief.md | system spec.json> <example name> "<why>" [--robot]')
	process.exit(2)
}
const dest = join("examples", name)
const { sentence } = JSON.parse(readFileSync(join(dest, "example.json"), "utf8")) as { sentence: string }
const seed = source.endsWith(".json")
	? (() => {
			const spec = JSON.parse(readFileSync(source, "utf8")) as SystemSpec
			const briefs = Object.fromEntries(spec.boards.map((b) => [b.name, readFileSync(resolve(dirname(source), b.brief ?? ""), "utf8")]))
			return starterSeed({ sentence, why, robot, spec, briefs })
		})()
	: starterSeed({ sentence, why, robot, briefs: { main: readFileSync(source, "utf8") } })
writeFileSync(join(dest, "starter.json"), JSON.stringify(seed, null, "\t") + "\n")
console.log(`${dest}/starter.json: ${seed.spec.boards.map((b) => b.name).join(", ")}`)
