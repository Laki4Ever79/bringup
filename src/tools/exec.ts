import { spawn } from "node:child_process"

export interface RunResult {
	code: number
	stdout: string
	stderr: string
	ms: number
}

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
		const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env } })
		const timer = setTimeout(() => {
			stderr += `\ntimed out after ${opts.timeoutMs} ms`
			child.kill("SIGKILL")
			done(-1)
		}, opts.timeoutMs)
		child.stdout.on("data", (d) => (stdout += d))
		child.stderr.on("data", (d) => (stderr += d))
		child.on("error", (error) => {
			stderr += String(error)
			done(-1)
		})
		child.on("close", (code) => done(code ?? -1))
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
