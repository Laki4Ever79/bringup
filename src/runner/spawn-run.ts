import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

export interface RunProcessArgs {
	briefPath: string
	mock: boolean
	outDir: string
}

export interface RunExit {
	// 0 settled, 2 unsettled, anything else failed (1 also for a spawn error or a kill)
	code: number
	stderr: string
	stdout: string
}

export interface RunProcess {
	done: Promise<RunExit>
	kill(): void
}

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url))
const TAIL_BYTES = 64 * 1024

// `tsx src/main.ts`, by absolute path so it works whatever the caller's cwd.
export function defaultCommand(): [string, ...string[]] {
	return [fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url)), fileURLToPath(new URL("../main.ts", import.meta.url))]
}

function keepTail(buf: string, chunk: Buffer): string {
	const next = buf + chunk.toString("utf8")
	return next.length > TAIL_BYTES ? next.slice(-TAIL_BYTES) : next
}

// One design run in its own process: Bringup allows one Mozaik runtime per process, so concurrent runs
// (MCP start_design, tournament branches) each get a child. Output is captured, never inherited, because
// the parent's stdout may be an MCP stdio stream. `done` never rejects.
export function startRunProcess(args: RunProcessArgs, opts: { command?: [string, ...string[]]; cwd?: string } = {}): RunProcess {
	const [bin, ...prefix] = opts.command ?? defaultCommand()
	const argv = [...prefix, args.briefPath, ...(args.mock ? ["--mock"] : []), "--out", args.outDir]
	const child = spawn(bin, argv, { cwd: opts.cwd ?? REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], env: process.env })
	let stdout = ""
	let stderr = ""
	child.stdout.on("data", (c: Buffer) => (stdout = keepTail(stdout, c)))
	child.stderr.on("data", (c: Buffer) => (stderr = keepTail(stderr, c)))

	const done = new Promise<RunExit>((resolve) => {
		child.once("error", (error) => resolve({ code: 1, stderr: `${stderr}${String(error)}\n`, stdout }))
		child.once("close", (code, signal) => {
			if (signal) resolve({ code: 1, stderr: `${stderr}killed by ${signal}\n`, stdout })
			else resolve({ code: code ?? 1, stderr, stdout })
		})
	})
	return {
		done,
		kill: () => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
		},
	}
}
