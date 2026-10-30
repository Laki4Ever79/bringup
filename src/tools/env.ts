import { existsSync } from "node:fs"
import { join } from "node:path"
import { getuid, getgid } from "node:process"
import { run, type RunResult } from "./exec.ts"

export const KICAD_IMAGE = "kicad/kicad:10.0"

export interface Env {
	root: string
	tsci: string | null
	kicad: "docker" | "local" | null
	python: string | null
	pio: string | null
}

const local = (root: string, rel: string) => (existsSync(join(root, rel)) ? join(root, rel) : null)

// Picks a backend per tool from what this machine has. Repo-local tools come first so a
// checkout stays self-contained; KiCad falls back from a local install to the Docker image.
export async function detectEnvironment(root: string): Promise<Env> {
	const [localKicad, dockerKicad] = await Promise.all([
		run("kicad-cli", ["version"], { timeoutMs: 10_000 }),
		run("docker", ["image", "inspect", KICAD_IMAGE], { timeoutMs: 10_000 }),
	])
	return {
		root,
		tsci: local(root, "tools/node/node_modules/.bin/tsci"),
		kicad: localKicad.code === 0 ? "local" : dockerKicad.code === 0 ? "docker" : null,
		python: local(root, ".venv/bin/python"),
		pio: local(root, ".venv/bin/pio"),
	}
}

// PATH for child processes, with the repo's node tools (tsci, bun) first.
export function toolPath(env: Env): string {
	return `${join(env.root, "tools/node/node_modules/.bin")}:${process.env.PATH ?? ""}`
}

export function kicadCli(env: Env, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
	if (env.kicad === "local") return run("kicad-cli", args, { cwd, timeoutMs })
	if (env.kicad === "docker") {
		const user = `${getuid?.() ?? 1000}:${getgid?.() ?? 1000}`
		return run("docker", ["run", "--rm", "-u", user, "-e", "HOME=/tmp", "-v", `${cwd}:/w`, "-w", "/w", KICAD_IMAGE, "kicad-cli", ...args], { timeoutMs })
	}
	return Promise.resolve({ code: -1, stdout: "", stderr: "KiCad is not available (no kicad-cli and no kicad/kicad:10.0 image)", ms: 0 })
}

export function describeEnv(env: Env): string {
	return [
		`tscircuit: ${env.tsci ?? "missing"}`,
		`KiCad 10:  ${env.kicad ?? "missing"}`,
		`python:    ${env.python ?? "missing"}`,
		`pio:       ${env.pio ?? "missing"}`,
	].join("\n")
}
