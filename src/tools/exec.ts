import { spawn } from "node:child_process"

export interface RunResult {
	code: number
	stdout: string
	stderr: string
	ms: number
}

// The children run() started that are still running, killed when this process exits: a run that ended at its revision
// budget left its board build (bun's tsci, re-parented to init) routing for minutes on a shared machine (real CNC run 2,
// 27 Nov 2026). On Linux and macOS each child leads its own process group, so the kill takes its own children too
// (tsci's workers, a shell's command); Windows has no groups, so the child alone.
const GROUPS = process.platform !== "win32"
const live = new Set<number>()
let hooked = false
function track(pid: number | undefined): void {
	if (pid === undefined) return
	live.add(pid)
	if (hooked) return
	hooked = true
	process.on("exit", killAll)
	// A child in its own group misses the terminal's Ctrl-C: kill the children, then exit as Node would have, unless
	// something else (a run that stays up) handles the signal itself.
	for (const sig of ["SIGINT", "SIGTERM"] as const)
		process.once(sig, () => {
			killAll()
			if (process.listenerCount(sig) === 0) process.kill(process.pid, sig)
		})
}
function killAll(): void {
	for (const p of live) {
		try {
			process.kill(GROUPS ? -p : p, "SIGKILL")
		} catch {}
	}
	live.clear()
}
export const liveChildren = (): number[] => [...live]

// Runs a command and always resolves: non-zero exits keep their code; a timeout or a
// missing binary is reported as code -1 with the reason in stderr.
export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number; env?: Record<string, string> }): Promise<RunResult> {
	const start = Date.now()
	return new Promise((resolve) => {
		let stdout = ""
		let stderr = ""
		let settled = false
		const done = (code: number) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			resolve({ code, stdout, stderr, ms: Date.now() - start })
		}
		// A .cmd or .bat (npm's shims on Windows) only runs through the shell.
		const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, ...(GROUPS ? { detached: true } : {}), ...(/\.(cmd|bat)$/i.test(cmd) ? { shell: true } : {}) })
		track(child.pid)
		const timer = setTimeout(() => {
			stderr += `\ntimed out after ${opts.timeoutMs} ms`
			try {
				if (GROUPS && child.pid !== undefined) process.kill(-child.pid, "SIGKILL")
				else child.kill("SIGKILL")
			} catch {
				child.kill("SIGKILL")
			}
			done(-1)
		}, opts.timeoutMs)
		child.stdout.on("data", (d) => (stdout += d))
		child.stderr.on("data", (d) => (stderr += d))
		child.on("error", (error) => {
			stderr += String(error)
			done(-1)
		})
		child.on("close", (code) => {
			if (child.pid !== undefined) live.delete(child.pid)
			done(code ?? -1)
		})
	})
}

export function tail(text: string, lines: number): string {
	return text.trimEnd().split("\n").slice(-lines).join("\n")
}

// A failed build's log for the agents and the report, in `lines`: its error lines first (a compiler names the cause in
// them, often thousands of lines before the end), then the tail. Before (26 Nov 2026) the last 40 lines of an ESP32-S3
// product firmware build showed only a NimBLE deprecation warning and "Error 1": the five "error:" lines (deep-sleep
// GPIO wake the S3 doesn't have) had scrolled out, and the run read as a NimBLE problem.
export function failureExcerpt(text: string, lines: number): string {
	const all = text.trimEnd().split("\n")
	if (all.length <= lines) return all.join("\n")
	const errors = [...new Set(all.filter((l) => /\b(fatal )?error\b[:]/i.test(l) || /^error\b/i.test(l.trim())))].slice(0, Math.floor(lines / 2))
	if (!errors.length) return tail(text, lines)
	const rest = all.slice(-(lines - errors.length - 1)).filter((l) => !errors.includes(l))
	return [...errors, "…", ...rest].join("\n")
}
