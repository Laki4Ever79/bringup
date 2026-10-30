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
