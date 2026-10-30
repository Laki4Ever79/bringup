import "dotenv/config"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT, runDesign } from "./run.ts"
import { describeEnv, detectEnvironment } from "./tools/env.ts"

function usage(): never {
	console.error("usage: npm run bringup -- <brief.md> [--mock] [--out <dir>]")
	process.exit(1)
}

const args = process.argv.slice(2)
const briefPath = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--out")
if (!briefPath || !existsSync(briefPath)) usage()
const mock = args.includes("--mock")
const outIndex = args.indexOf("--out")
const runId = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)
const outDir = outIndex >= 0 ? args[outIndex + 1] : join(ROOT, "out", runId)

const env = await detectEnvironment(ROOT)
console.log(`bringup: ${mock ? "mock models (no API key)" : "real models"}\n${describeEnv(env)}\noutput: ${outDir}`)
if (!env.tsci || !env.kicad || !env.python || !env.pio) {
	console.error("bringup: a required tool is missing (see above); install steps are in README.md")
	process.exit(1)
}

const result = await runDesign({ brief: readFileSync(briefPath, "utf8"), mock, outDir, env })
console.log(`\n${result.settled ? "settled" : "UNSETTLED"} at revision ${result.revision} with ${result.violations.length} violation(s)\nreport: ${result.reportPath}`)
process.exit(result.settled ? 0 : 2)
