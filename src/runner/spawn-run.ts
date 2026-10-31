import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

export interface RunProcessArgs {
	briefPath: string
	mock: boolean
	outDir: string
	// Flags for src/main.ts after the brief, e.g. --no-hardware, --no-review, --engineer-approval.
	extraArgs?: string[]
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

function keepTail(buf: string, chunk: string): string {
	const next = buf + chunk
	return next.length > TAIL_BYTES ? next.slice(-TAIL_BYTES) : next
}

export interface RunProcessOptions {
	command?: [string, ...string[]]
	cwd?: string
	// Live output, chunk by chunk, for callers that relay part of it (the demo's Cloud links).
	onStdout?: (chunk: string) => void
	onStderr?: (chunk: string) => void
}

// One design run in its own process: Bringup allows one Mozaik runtime per process, so concurrent runs
// (MCP start_design, tournament branches) each get a child. Output is captured, never inherited, because
// the parent's stdout may be an MCP stdio stream. `done` never rejects.
export function startRunProcess(args: RunProcessArgs, opts: RunProcessOptions = {}): RunProcess {
	const [bin, ...prefix] = opts.command ?? defaultCommand()
	const argv = [...prefix, args.briefPath, ...(args.mock ? ["--mock"] : []), ...(args.extraArgs ?? []), "--out", args.outDir]
	// stdin is a pipe this process never writes to: when it goes away, however it goes (Ctrl-C, SIGTERM, SIGKILL, a
	// closed terminal), the OS closes the pipe and a run that stays up (--stay, --bench) ends instead of lingering.
	const child = spawn(bin, argv, { cwd: opts.cwd ?? REPO_ROOT, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, BRINGUP_PARENT_PIPE: "1" } })
	child.stdin.on("error", () => {}) // the run may exit first; nothing is ever written anyway
	let stdout = ""
	let stderr = ""
	child.stdout.setEncoding("utf8")
	child.stderr.setEncoding("utf8")
	child.stdout.on("data", (c: string) => {
		stdout = keepTail(stdout, c)
		opts.onStdout?.(c)
	})
	child.stderr.on("data", (c: string) => {
		stderr = keepTail(stderr, c)
		opts.onStderr?.(c)
	})

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
