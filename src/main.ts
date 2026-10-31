import "dotenv/config"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { missingTools } from "./report.ts"
import { ROOT, runDesign } from "./run.ts"
import { describeEnv, detectEnvironment, type Env } from "./tools/env.ts"
import { openBench } from "./bench/open.ts"
import { startBridge, type BenchSource } from "./tools/bench-bridge.ts"

const USAGE = "usage: npm run bringup -- <brief.md> [--mock] [--no-hardware] [--no-review] [--engineer-approval] [--review-rounds N] [--out <dir>] [--bench [real|fake|replay]] [--bench-replay <bench.jsonl>] [--bench-no-meter] [--bench-no-imu] [--change <request>]... [--change-delay <s>] [--stay]"

const BENCH_SOURCES = ["real", "fake", "replay"] as const

export interface CliArgs {
	briefPath: string
	mock: boolean
	noHardware: boolean
	review: boolean
	engineerApproval: boolean
	outDir?: string
	reviewRounds?: number
	// --bench: bring-up on the desk after settling, until Ctrl-C. real falls back to a replay, then the fake bench.
	bench?: BenchSource
	benchReplay?: string
	// The fake bench without a meter: a tier-1 (pocket) bench, for trying the dashboard without hardware.
	benchNoMeter?: boolean
	// The fake bench without an MPU-6050; with benchNoMeter, a bare ESP32-S3.
	benchNoImu?: boolean
	// --change, repeatable: engineer change requests sent one at a time, each after the design has settled.
	changes?: string[]
	// Seconds to wait after each settle before the next --change goes out, so the settled design can be seen first.
	changeDelayMs?: number
	// After settling (and after the --change requests), keep taking change requests until Ctrl-C or SIGTERM.
	stay?: boolean
}

export function parseArgs(argv: string[]): CliArgs | { error: string } {
	const outIndex = argv.indexOf("--out")
	const outDir = outIndex >= 0 ? argv[outIndex + 1] : undefined
	if (outIndex >= 0 && (!outDir || outDir.startsWith("--"))) return { error: "--out needs a directory" }
	const roundsIndex = argv.indexOf("--review-rounds")
	const reviewRounds = roundsIndex >= 0 ? Number(argv[roundsIndex + 1]) : undefined
	if (roundsIndex >= 0 && !(Number.isInteger(reviewRounds) && reviewRounds! >= 1)) return { error: "--review-rounds needs a whole number of at least 1" }
	const benchIndex = argv.indexOf("--bench")
	const benchSource = benchIndex >= 0 && (BENCH_SOURCES as readonly string[]).includes(argv[benchIndex + 1]) ? (argv[benchIndex + 1] as BenchSource) : undefined
	const replayIndex = argv.indexOf("--bench-replay")
	const benchReplay = replayIndex >= 0 ? argv[replayIndex + 1] : undefined
	if (replayIndex >= 0 && (!benchReplay || benchReplay.startsWith("--"))) return { error: "--bench-replay needs a recorded bench.jsonl" }
	const changeIndexes = argv.flatMap((a, i) => (a === "--change" ? [i] : []))
	const changes = changeIndexes.map((i) => argv[i + 1]?.trim() ?? "")
	if (changes.some((c) => !c || c.startsWith("--"))) return { error: "--change needs the request text" }
	const delayIndex = argv.indexOf("--change-delay")
	const delayS = delayIndex >= 0 ? Number(argv[delayIndex + 1]) : undefined
	if (delayIndex >= 0 && !(Number.isFinite(delayS) && delayS! >= 0)) return { error: "--change-delay needs a number of seconds" }
	const valueAt = new Set([outIndex, roundsIndex, replayIndex, delayIndex, ...changeIndexes, ...(benchSource ? [benchIndex] : [])].filter((i) => i >= 0).map((i) => i + 1))
	const briefPath = argv.find((a, i) => !a.startsWith("--") && !valueAt.has(i))
	if (!briefPath) return { error: "no brief given" }
	if (!existsSync(briefPath)) return { error: `brief not found: ${briefPath}` }
	return { briefPath, mock: argv.includes("--mock"), noHardware: argv.includes("--no-hardware"), review: !argv.includes("--no-review"), engineerApproval: argv.includes("--engineer-approval"), ...(outDir ? { outDir } : {}), ...(reviewRounds ? { reviewRounds } : {}), ...(benchIndex >= 0 || benchReplay ? { bench: benchSource ?? (benchReplay ? "replay" : "real") } : {}), ...(benchReplay ? { benchReplay } : {}), ...(argv.includes("--bench-no-meter") ? { benchNoMeter: true } : {}), ...(argv.includes("--bench-no-imu") ? { benchNoImu: true } : {}), ...(changes.length > 0 ? { changes } : {}), ...(delayS !== undefined ? { changeDelayMs: delayS * 1000 } : {}), ...(argv.includes("--stay") ? { stay: true } : {}) }
}

// A run started by the hub or the demo (spawn-run.ts) has a stdin pipe from it: when that closes, its parent is
// gone, so a run that stays up ends instead of lingering. null when there is no such pipe (started by hand).
export function parentGone(stdin: NodeJS.ReadableStream, env: Record<string, string | undefined>): Promise<void> | null {
	if (env.BRINGUP_PARENT_PIPE !== "1") return null
	return new Promise((resolve) => {
		stdin.once("end", () => resolve())
		stdin.once("close", () => resolve())
		stdin.resume()
	})
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
	const mode = `${args.mock ? "mock models (no API key)" : "real models"}${args.noHardware ? ", hardware stubbed" : ""}${args.review ? "" : ", no brief review"}`
	console.log(`bringup: ${mode}\n${describeEnv(env)}\noutput: ${outDir}`)
	const missing = missingTools(env)
	if (missing.length > 0 && !args.noHardware) {
		console.warn(`bringup: WARNING: missing ${missing.map((m) => m.tool).join(", ")}; those builds will fail and the run will end unsettled.`)
		for (const m of missing) console.warn(`  ${m.tool}: ${m.install}`)
		console.warn("  Or rerun with --no-hardware to see the agents coordinate without the hardware tools.")
	}

	// Ctrl-C, or SIGTERM from the dashboard hub stopping the run: ends a run that stays up (--stay, --bench). Only
	// then are the signals caught; otherwise Ctrl-C ends the run as usual.
	const until = new Promise<void>((resolve) => {
		if (!args.stay && !args.bench) return
		process.once("SIGINT", () => resolve())
		process.once("SIGTERM", () => resolve())
		void parentGone(process.stdin, process.env)?.then(resolve)
	})
	if (args.stay) console.log("bringup: --stay; after the design settles the run keeps taking change requests. Ctrl-C ends it.")
	let bench: Parameters<typeof runDesign>[0]["bench"]
	if (args.bench) {
		if (!env.python || !existsSync(join(ROOT, "py/bench.py"))) {
			console.error("bringup: --bench needs .venv/bin/python and py/bench.py (see docs/design/bench.md)")
			return 1
		}
		const python = env.python
		const source = args.bench
		console.log(`bringup: bench ${source}; after the design settles the run stays up for bring-up. Ctrl-C ends it.`)
		bench = {
			until,
			open: () => openBench({ root: ROOT, source, outDir, replay: args.benchReplay, extraArgs: [...(args.benchNoMeter ? ["--no-meter"] : []), ...(args.benchNoImu ? ["--no-imu"] : [])], start: (a) => startBridge(python, a, { cwd: ROOT, onStderr: (t) => process.stderr.write(`[bench.py] ${t}`) }) }),
		}
	}
	const result = await runDesign({ brief: readFileSync(args.briefPath, "utf8"), mock: args.mock, outDir, env, noHardware: args.noHardware, review: args.review, engineerApproval: args.engineerApproval, maxReviewRounds: args.reviewRounds, bench, changes: args.changes, changeDelayMs: args.changeDelayMs, ...(args.stay ? { stay: { until } } : {}) })
	console.log(`\n${result.settled ? "settled" : "UNSETTLED"} at revision ${result.revision} with ${result.violations.length} violation(s)\nreport: ${result.reportPath}`)
	return result.settled ? 0 : 2
}

// Run only when executed (tsx src/main.ts), not when a test imports main().
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)))
