import "dotenv/config"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { missingTools } from "./report.ts"
import { ROOT, runDesign } from "./run.ts"
import { describeEnv, detectEnvironment, type Env } from "./tools/env.ts"

const USAGE = "usage: npm run bringup -- <brief.md> [--mock] [--no-hardware] [--out <dir>]"

export interface CliArgs {
	briefPath: string
	mock: boolean
	noHardware: boolean
	outDir?: string
}

export function parseArgs(argv: string[]): CliArgs | { error: string } {
	const outIndex = argv.indexOf("--out")
	const outDir = outIndex >= 0 ? argv[outIndex + 1] : undefined
	if (outIndex >= 0 && (!outDir || outDir.startsWith("--"))) return { error: "--out needs a directory" }
	const briefPath = argv.find((a, i) => !a.startsWith("--") && (outIndex < 0 || i !== outIndex + 1))
	if (!briefPath) return { error: "no brief given" }
	if (!existsSync(briefPath)) return { error: `brief not found: ${briefPath}` }
	return { briefPath, mock: argv.includes("--mock"), noHardware: argv.includes("--no-hardware"), ...(outDir ? { outDir } : {}) }
}

// Returns the exit code: 0 settled, 2 unsettled, 1 bad arguments. A missing tool is a warning, not an exit:
// its builder reports artifact.failed and the run ends unsettled with a report naming what to install.
export async function main(argv: string[], deps: { detect?: (root: string) => Promise<Env> } = {}): Promise<number> {
	const args = parseArgs(argv)
	if ("error" in args) {
		console.error(`bringup: ${args.error}\n${USAGE}`)
		return 1
	}
	const runId = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)
	const outDir = args.outDir ?? join(ROOT, "out", runId)
	const env = await (deps.detect ?? detectEnvironment)(ROOT)
	const mode = `${args.mock ? "mock models (no API key)" : "real models"}${args.noHardware ? ", hardware stubbed" : ""}`
	console.log(`bringup: ${mode}\n${describeEnv(env)}\noutput: ${outDir}`)
	const missing = missingTools(env)
	if (missing.length > 0 && !args.noHardware) {
		console.warn(`bringup: WARNING: missing ${missing.map((m) => m.tool).join(", ")}; those builds will fail and the run will end unsettled.`)
		for (const m of missing) console.warn(`  ${m.tool}: ${m.install}`)
		console.warn("  Or rerun with --no-hardware to see the agents coordinate without the hardware tools.")
	}

	const result = await runDesign({ brief: readFileSync(args.briefPath, "utf8"), mock: args.mock, outDir, env, noHardware: args.noHardware })
	console.log(`\n${result.settled ? "settled" : "UNSETTLED"} at revision ${result.revision} with ${result.violations.length} violation(s)\nreport: ${result.reportPath}`)
	return result.settled ? 0 : 2
}

// Run only when executed (tsx src/main.ts), not when a test imports main().
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)))
