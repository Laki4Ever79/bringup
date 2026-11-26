import { spawnSync } from "node:child_process"
import { mount } from "./mount.ts"
import { resolve } from "node:path"
import { randomBytes } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { delimiter, join, sep } from "node:path"
import { run, type RunResult } from "./exec.ts"
import { renodePath } from "./renode.ts"
import { popplerAvailable } from "../learn/docs.ts"
import { imagePresent, mountDirs, toolchainImage, writeShims } from "./toolchain.ts"

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
	// Renode in tools/renode (docs/mcu.md, Simulation): boots STM32 and nRF52 firmware. Optional.
	renode?: string | null
	// poppler's pdfinfo, pdftotext and pdftoppm on PATH: the part learner reads datasheets with them. Optional.
	poppler?: boolean
	// Set when tsci, python or pio run in the toolchain image (src/tools/toolchain.ts) because this machine lacks them.
	toolchain?: { image: string; tools: string[] }
	// The pinned Node tools' node_modules (tscircuit, bun, react): a board build links its work dir to it, and child
	// processes get its .bin first on PATH. The repo's tools/node, else the npm install's ~/.bringup/tools/node.
	nodeModules?: string | null
}

// Where an npm or npx install keeps the tools it installs on request (`npx bringup-mcp setup <domain>`,
// src/setup/domains.ts): ~/.bringup, or BRINGUP_HOME. A git checkout keeps its own in tools/ and .venv/ beside the repo,
// and those come first.
// The tools' file names on this platform: npm installs a .cmd shim on Windows, and a Python venv keeps its programs in
// Scripts\ there (bin/ elsewhere).
const WIN = process.platform === "win32"
export const BIN = { tsci: WIN ? "tsci.cmd" : "tsci" } as const
export const VENV = { python: WIN ? ".venv/Scripts/python.exe" : ".venv/bin/python", pio: WIN ? ".venv/Scripts/pio.exe" : ".venv/bin/pio" } as const

export const bringupHome = (): string => process.env.BRINGUP_HOME ?? join(homedir(), ".bringup")
// A tool's path in the repo, else in the tools home; null when neither has it.
export function toolAt(root: string, rel: string): string | null {
	for (const base of [root, bringupHome()]) if (existsSync(join(base, rel))) return join(base, rel)
	return null
}

const local = (root: string, rel: string) => (existsSync(join(root, rel)) ? join(root, rel) : null)

// Picks a backend per tool from what this machine has. Repo-local tools come first so a
// checkout stays self-contained; KiCad falls back from a local install to the Docker image.
export async function detectEnvironment(root: string): Promise<Env> {
	// Either of Espressif's QEMUs (src/tools/qemu.ts): the riscv32 one (ESP32-C3), else the xtensa one (ESP32-S3); each
	// run checks its own chip's binary.
	const qemuPath = local(root, "tools/qemu/bin/qemu-system-riscv32") ?? local(root, "tools/qemu/bin/qemu-system-xtensa")
	const [localKicad, dockerKicad, qemu] = await Promise.all([
		run("kicad-cli", ["version"], { timeoutMs: 10_000 }),
		run("docker", ["image", "inspect", KICAD_IMAGE], { timeoutMs: 10_000 }),
		qemuPath ? run(qemuPath, ["--version"], { timeoutMs: 10_000, env: qemuEnv(root) }) : Promise.resolve(null),
	])
	const tsciBin = toolAt(root, `tools/node/node_modules/.bin/${BIN.tsci}`)
	const nodeModules = tsciBin ? join(tsciBin, "..", "..") : null
	const tools = { tsci: tsciBin, python: toolAt(root, VENV.python), pio: toolAt(root, VENV.pio) }
	const toolchain = await dockerToolchain(root, tools)
	return {
		root,
		...tools,
		nodeModules,
		...(toolchain ? { ...toolchain.shims, toolchain: { image: toolchain.image, tools: toolchain.tools } } : {}),
		kicad: localKicad.code === 0 ? "local" : dockerKicad.code === 0 ? "docker" : null,
		qemu: qemu?.code === 0 ? qemuPath : null,
		wokwi: local(root, "tools/wokwi-cli/wokwi-cli"),
		wokwiToken: Boolean(process.env.WOKWI_CLI_TOKEN),
		renode: renodePath(root),
		poppler: Object.values(await popplerAvailable()).every(Boolean),
	}
}

// The tools this machine lacks, run from the toolchain image when it is here (src/tools/toolchain.ts prepares it).
// Local tools always win; BRINGUP_TOOLCHAIN=local turns the image off.
async function dockerToolchain(root: string, tools: Record<"tsci" | "python" | "pio", string | null>) {
	const missing = (Object.keys(tools) as (keyof typeof tools)[]).filter((t) => !tools[t])
	if (missing.length === 0 || process.env.BRINGUP_TOOLCHAIN === "local") return null
	const image = toolchainImage(root)
	if (!image || !(await imagePresent(image))) return null
	const all = writeShims(image, mountDirs(root))
	return { image, tools: missing, shims: Object.fromEntries(missing.map((t) => [t, all[t]])) }
}

// Espressif's prebuilt QEMU links libslirp, which NOTES.md installs into tools/qemu/lib.
export function qemuEnv(root: string): Record<string, string> {
	return { LD_LIBRARY_PATH: [join(root, "tools/qemu/lib"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") }
}

// PATH for child processes, with the repo's node tools (tsci, bun) first.
export function toolPath(env: Env): string {
	return `${join(env.nodeModules ?? join(env.root, "tools/node/node_modules"), ".bin")}${delimiter}${process.env.PATH ?? ""}`
}

// One KiCad container per process for the calls in the temporary folders, where every board build, DRC and fab export
// runs: a fresh `docker run` per call cost ~0.7 s against ~0.3 s for an exec into a running one, 6 calls per board
// revision (the isolation audit, 14 Nov 2026). The temporary folder is mounted at its own path, so paths and the
// caller's folder are as before. The container ends itself after CONTAINER_LIFE_S (a `sleep`, so an orphan can't
// linger), is replaced before that, and is removed when the process exits.
const CONTAINER_LIFE_S = 1800
const RENEW_BEFORE_S = 300 // past the longest call's timeout (180 s)
let shared: { name: string; until: number } | null = null
let starting: Promise<string | null> | null = null
let cleanupHooked = false
const user = () => `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`
const tmpRoot = () => realpathSync(tmpdir())

// The shared container's name, while there is one (for tests).
export function kicadContainer(): string | null {
	return shared?.name ?? null
}

async function sharedContainer(): Promise<string | null> {
	if (shared && Date.now() < shared.until) return shared.name
	if (starting) return starting
	starting = (async () => {
		const name = `bringup-kicad-${process.pid}-${randomBytes(3).toString("hex")}`
		const root = tmpRoot()
		const r = await run("docker", ["run", "-d", "--rm", "--name", name, "-u", user(), "-e", "HOME=/var/tmp", "-v", mount(root, resolve(root)), KICAD_IMAGE, "sleep", String(CONTAINER_LIFE_S)], { timeoutMs: 60_000 })
		if (r.code !== 0) return null
		// The one it replaces finishes on its own (its sleep ends); calls already in it run to their end.
		shared = { name, until: Date.now() + (CONTAINER_LIFE_S - RENEW_BEFORE_S) * 1000 }
		if (!cleanupHooked) {
			cleanupHooked = true
			process.on("exit", () => {
				if (shared) spawnSync("docker", ["rm", "-f", shared.name], { stdio: "ignore" })
			})
		}
		return name
	})().finally(() => (starting = null))
	return starting
}

export async function kicadCli(env: Env, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
	if (env.kicad === "local") return run("kicad-cli", args, { cwd, timeoutMs })
	if (env.kicad === "docker") {
		const real = existsSync(cwd) ? realpathSync(cwd) : cwd
		if (real.startsWith(tmpRoot() + sep)) {
			const name = await sharedContainer()
			if (name) {
				const r = await run("docker", ["exec", "-u", user(), "-w", real, name, "kicad-cli", ...args], { timeoutMs })
				// The container went away under us (stopped by hand, the daemon restarted): start another, once.
				if (r.code !== 125 && !/No such container|is not running/.test(r.stderr)) return r
				shared = null
				const again = await sharedContainer()
				if (again) return run("docker", ["exec", "-u", user(), "-w", real, again, "kicad-cli", ...args], { timeoutMs })
			}
		}
		return run("docker", ["run", "--rm", "-u", user(), "-e", "HOME=/tmp", "-v", mount(cwd, "/w"), "-w", "/w", KICAD_IMAGE, "kicad-cli", ...args], { timeoutMs })
	}
	return Promise.resolve({ code: -1, stdout: "", stderr: "KiCad is not available (no kicad-cli and no kicad/kicad:10.0 image)", ms: 0 })
}

export function describeEnv(env: Env): string {
	return [
		`tscircuit: ${env.tsci ?? "missing"}`,
		`KiCad 10:  ${env.kicad ?? "missing"}`,
		`python:    ${env.python ?? "missing"}`,
		`pio:       ${env.pio ?? "missing"}`,
		...(env.toolchain ? [`toolchain: ${env.toolchain.tools.join(", ")} in Docker (${env.toolchain.image})`] : []),
		`QEMU:      ${env.qemu ?? "missing (optional)"}`,
		`Renode:    ${env.renode ?? "missing (optional: STM32/nRF52 simulation, npm run setup)"}`,
		`Wokwi:     ${env.wokwi && env.wokwiToken ? `${env.wokwi} (token set)` : "not set up (optional: WOKWI_CLI_TOKEN in .env and tools/wokwi-cli, see NOTES.md)"}`,
	].join("\n")
}

// Which firmware simulator this machine has: Wokwi (the firmware runs with the sensor answering) when its CLI is in
// tools/ and a token is set, else Espressif's QEMU (boot only, no sensor), else none.
export function firmwareSimBackend(env: Env): "wokwi" | "qemu" | null {
	if (env.wokwi && env.wokwiToken) return "wokwi"
	return env.qemu ? "qemu" : null
}
