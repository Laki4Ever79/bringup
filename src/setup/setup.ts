// `npm run setup`: the README's Install steps, in order, skipping what is already there. Repo-local only (.venv,
// tools/node, tools/qemu); the exceptions are the ones the README names: PlatformIO's ~/.platformio and Docker's image
// store. Never sudo, never system-wide. Optional parts only behind their flags (--qemu, --wokwi).
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { WOKWI_CHIPS, WOKWI_CLI } from "../tools/wokwi.ts"

export interface Probe {
	nodeVersion: string
	// A quick command whose exit code answers a question (uv --version, docker info).
	check(cmd: string, args: string[]): Promise<{ code: number; out: string }>
	// Whether a step's result is already on this machine.
	present(step: StepId): Promise<boolean>
	// Runs an install command with its output shown; resolves to the exit code.
	install(cmd: string, args: string[]): Promise<number>
	log(line: string): void
	// For --wokwi (all paths relative to the repo root): "<os>-<arch>", file checks, the download and its placing.
	platform?: string
	exists?(path: string): Promise<boolean>
	sha256?(path: string): Promise<string | null>
	download?(url: string, to: string): Promise<boolean>
	// Moves a verified download into place and makes it executable.
	place?(from: string, to: string): Promise<void>
	remove?(path: string): Promise<void>
}

export type StepId = "python" | "tscircuit" | "kicad" | "toolchain" | "qemu"

interface Step {
	id: StepId
	name: string
	commands: [string, string[]][]
}

// The same commands and pins as the README's Install block.
export const INSTALL: Step[] = [
	{
		id: "python",
		name: "python tools (.venv)",
		commands: [
			["uv", ["venv", "--allow-existing", "--python", "3.12", ".venv"]],
			["uv", ["pip", "install", "--python", ".venv/bin/python", "platformio==6.2.0", "build123d==0.13.0"]],
		],
	},
	{ id: "tscircuit", name: "tscircuit + bun (tools/node)", commands: [["npm", ["i", "--prefix", "tools/node", "tscircuit@0.0.3042", "bun@1.4.4"]]] },
	{ id: "kicad", name: "KiCad 10 (Docker image)", commands: [["docker", ["pull", "kicad/kicad:10.0"]]] },
	{ id: "toolchain", name: "ESP32-C3 toolchain (PlatformIO)", commands: [[".venv/bin/pio", ["pkg", "install", "-d", "templates/fw", "-e", "esp32c3"]]] },
]

// NOTES.md "Firmware emulation": Espressif's prebuilt QEMU into tools/qemu, and libslirp fetched user-level with
// `apt download` (no install, no sudo).
const QEMU_URL = "https://github.com/espressif/qemu/releases/download/esp-develop-9.2.2-20260417/qemu-riscv32-softmmu-esp_develop_9.2.2_20260417-x86_64-linux-gnu.tar.xz"
export const QEMU: Step = {
	id: "qemu",
	name: "QEMU (tools/qemu)",
	commands: [
		["bash", ["-c", `set -e; mkdir -p tools && cd tools && curl -fL -o qemu.tar.xz ${QEMU_URL} && tar xf qemu.tar.xz && rm qemu.tar.xz`]],
		["bash", ["-c", "set -e; d=$(mktemp -d); (cd $d && apt download libslirp0 && dpkg -x libslirp0_*.deb x); mkdir -p tools/qemu/lib; cp -a $d/x/usr/lib/x86_64-linux-gnu/libslirp.so.0* tools/qemu/lib/; rm -rf $d"]],
	],
}

export async function checkPrerequisites(probe: Probe): Promise<string[]> {
	const problems: string[] = []
	const major = Number(probe.nodeVersion.split(".")[0])
	if (major !== 24) problems.push(`Node 24 is needed (this is Node ${probe.nodeVersion}): install Node 24, then re-run.`)
	if ((await probe.check("uv", ["--version"])).code !== 0) problems.push("uv isn't installed: install it from https://docs.astral.sh/uv/ (user-level), then re-run.")
	const docker = await probe.check("docker", ["info"])
	if (docker.code !== 0) {
		if (/ENOENT|not found/i.test(docker.out)) problems.push("Docker isn't installed: install Docker, then re-run (KiCad and ngspice run in its kicad/kicad:10.0 image).")
		else if (/permission denied/i.test(docker.out)) problems.push("Docker needs sudo here: it must work without sudo (add yourself to the docker group, log in again), then re-run.")
		else problems.push("Docker isn't running: start it, then re-run.")
	}
	return problems
}

export interface SetupSummary {
	ok: boolean
	lines: string[]
}

export async function runSetup(probe: Probe, flags: { qemu?: boolean; wokwi?: boolean }): Promise<SetupSummary> {
	const problems = await checkPrerequisites(probe)
	if (problems.length > 0) {
		for (const p of problems) probe.log(p)
		return { ok: false, lines: problems }
	}
	const lines: string[] = []
	let ok = true
	const doStep = async (step: Step) => {
		if (await probe.present(step.id)) return lines.push(`${step.name}: already there`)
		probe.log(`setup: ${step.name}`)
		for (const [cmd, args] of step.commands) {
			const code = await probe.install(cmd, args)
			if (code !== 0) {
				ok = false
				return lines.push(`${step.name}: FAILED (${[cmd, ...args].join(" ").slice(0, 120)} exited ${code})`)
			}
		}
		lines.push(`${step.name}: installed`)
	}
	for (const step of INSTALL) await doStep(step)
	if (flags.qemu) await doStep(QEMU)
	else lines.push(`${QEMU.name}: ${(await probe.present("qemu")) ? "already there" : "not installed (optional: npm run setup -- --qemu)"}`)
	const wokwi = await wokwiStep(probe, Boolean(flags.wokwi))
	ok &&= wokwi.ok
	lines.push(wokwi.line)
	return { ok, lines }
}

// Wokwi's CLI, pinned by src/tools/wokwi.ts (WOKWI_CLI, WOKWI_CHIPS): the one source of truth with the simulator. The
// download is checked against the pinned sha256 before it is put in place; then each sensor chip is compiled once
// (the first compile fetches a WASI SDK into ~/.wokwi, about 360 MB). The token (WOKWI_CLI_TOKEN) is the user's to add.
const chipOut = (c: string) => `tools/wokwi-cli/chips/${c}.chip.wasm`

async function wokwiStep(probe: Probe, wanted: boolean): Promise<{ ok: boolean; line: string }> {
	const name = `Wokwi CLI ${WOKWI_CLI.version} (tools/wokwi-cli)`
	const has = async (p: string) => (await probe.exists?.(p)) ?? false
	const binaryOk = async () => (await has(WOKWI_CLI.dest)) && (await probe.sha256?.(WOKWI_CLI.dest)) === WOKWI_CLI.sha256
	const missingChips = async () => {
		const out: string[] = []
		for (const c of WOKWI_CHIPS) if (!(await has(chipOut(c)))) out.push(c)
		return out
	}
	if (!wanted) {
		const ready = (await binaryOk()) && (await missingChips()).length === 0
		return { ok: true, line: `${name}: ${ready ? "already there" : "not installed (optional: npm run setup -- --wokwi, plus WOKWI_CLI_TOKEN in .env)"}` }
	}
	if (probe.platform !== "linux-x64") return { ok: false, line: `Wokwi CLI: linux x64 only for now (this is ${probe.platform}); no other release asset is pinned` }
	const chips = await missingChips()
	const binary = await binaryOk()
	if (binary && chips.length === 0) return { ok: true, line: `${name}: already there` }
	if (!binary) {
		probe.log(`setup: ${name}`)
		const tmp = `${WOKWI_CLI.dest}.download`
		if (!(await probe.download!(WOKWI_CLI.url, tmp))) return { ok: false, line: `${name}: FAILED (download of ${WOKWI_CLI.url})` }
		const got = await probe.sha256!(tmp)
		if (got !== WOKWI_CLI.sha256) {
			await probe.remove!(tmp)
			return { ok: false, line: `${name}: FAILED (sha256 mismatch: got ${got}, pinned ${WOKWI_CLI.sha256})` }
		}
		await probe.place!(tmp, WOKWI_CLI.dest)
	}
	for (const c of chips) {
		const code = await probe.install(WOKWI_CLI.dest, ["chip", "compile", "-o", chipOut(c), `templates/wokwi/chips/${c}.chip.c`])
		if (code !== 0) return { ok: false, line: `${name}: FAILED (chip compile ${c} exited ${code})` }
	}
	return { ok: true, line: `${name}: installed` }
}

// What "present" means on this machine, step by step.
export function presentOn(root: string, check: Probe["check"]): Probe["present"] {
	const pioHome = process.env.PLATFORMIO_CORE_DIR ?? join(homedir(), ".platformio")
	const version = (path: string) => {
		try {
			return JSON.parse(readFileSync(path, "utf8")).version as string
		} catch {
			return null
		}
	}
	return async (step) => {
		if (step === "python") {
			const r = await check(join(root, ".venv/bin/python"), ["-c", "import importlib.metadata as m; print(m.version('platformio'), m.version('build123d'))"])
			return r.code === 0 && r.out.trim() === "6.2.0 0.13.0"
		}
		if (step === "tscircuit") return version(join(root, "tools/node/node_modules/tscircuit/package.json")) === "0.0.3042" && version(join(root, "tools/node/node_modules/bun/package.json")) === "1.4.4"
		if (step === "kicad") return (await check("docker", ["image", "inspect", "kicad/kicad:10.0"])).code === 0
		if (step === "toolchain")
			return (
				version(join(pioHome, "platforms/espressif32/platform.json")) === "8.0.0" &&
				existsSync(join(pioHome, "packages/toolchain-riscv32-esp")) &&
				existsSync(join(pioHome, "packages/framework-arduinoespressif32")) &&
				existsSync(join(root, "templates/fw/.pio/libdeps/esp32c3/NimBLE-Arduino"))
			)
		return existsSync(join(root, "tools/qemu/bin/qemu-system-riscv32")) && existsSync(join(root, "tools/qemu/lib"))
	}
}
