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
	// Espressif's QEMU in tools/qemu, only if it actually starts (it needs tools/qemu/lib, see NOTES.md). Optional.
	qemu?: string | null
	// Wokwi's CLI in tools/wokwi-cli (NOTES.md), and whether WOKWI_CLI_TOKEN is set (the token itself is never kept
	// here or printed). Optional: with both, firmware can be simulated with the sensor answering.
	wokwi?: string | null
	wokwiToken?: boolean
}

const local = (root: string, rel: string) => (existsSync(join(root, rel)) ? join(root, rel) : null)

// Picks a backend per tool from what this machine has. Repo-local tools come first so a
// checkout stays self-contained; KiCad falls back from a local install to the Docker image.
export async function detectEnvironment(root: string): Promise<Env> {
	const qemuPath = local(root, "tools/qemu/bin/qemu-system-riscv32")
	const [localKicad, dockerKicad, qemu] = await Promise.all([
		run("kicad-cli", ["version"], { timeoutMs: 10_000 }),
		run("docker", ["image", "inspect", KICAD_IMAGE], { timeoutMs: 10_000 }),
		qemuPath ? run(qemuPath, ["--version"], { timeoutMs: 10_000, env: qemuEnv(root) }) : Promise.resolve(null),
	])
	return {
		root,
		tsci: local(root, "tools/node/node_modules/.bin/tsci"),
		kicad: localKicad.code === 0 ? "local" : dockerKicad.code === 0 ? "docker" : null,
		python: local(root, ".venv/bin/python"),
		pio: local(root, ".venv/bin/pio"),
		qemu: qemu?.code === 0 ? qemuPath : null,
		wokwi: local(root, "tools/wokwi-cli/wokwi-cli"),
		wokwiToken: Boolean(process.env.WOKWI_CLI_TOKEN),
	}
}

// Espressif's prebuilt QEMU links libslirp, which NOTES.md installs into tools/qemu/lib.
export function qemuEnv(root: string): Record<string, string> {
	return { LD_LIBRARY_PATH: [join(root, "tools/qemu/lib"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") }
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
		`QEMU:      ${env.qemu ?? "missing (optional)"}`,
		`Wokwi:     ${env.wokwi && env.wokwiToken ? `${env.wokwi} (token set)` : "not set up (optional: WOKWI_CLI_TOKEN in .env and tools/wokwi-cli, see NOTES.md)"}`,
	].join("\n")
}

// Which firmware simulator this machine has: Wokwi (the firmware runs with the sensor answering) when its CLI is in
// tools/ and a token is set, else Espressif's QEMU (boot only, no sensor), else none.
export function firmwareSimBackend(env: Env): "wokwi" | "qemu" | null {
	if (env.wokwi && env.wokwiToken) return "wokwi"
	return env.qemu ? "qemu" : null
}
