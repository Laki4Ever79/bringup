import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { checkPrerequisites, INSTALL, runSetup, type Probe } from "../src/setup/setup.ts"
import { doctorReport } from "../src/setup/doctor.ts"
import { WOKWI_CHIPS, WOKWI_CLI } from "../src/tools/wokwi.ts"

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8")

// A machine where `ready` names what is already installed; every command run is recorded.
function machine(opts: { node?: string; uv?: boolean; docker?: "ok" | "down" | "missing" | "denied"; ready?: string[] } = {}) {
	const ran: string[] = []
	const ready = new Set(opts.ready ?? [])
	const probe: Probe = {
		nodeVersion: opts.node ?? "24.0.2",
		async check(cmd, args) {
			const line = [cmd, ...args].join(" ")
			if (cmd === "uv") return { code: opts.uv === false ? -1 : 0, out: "uv 0.10.2" }
			if (line === "docker info") {
				const d = opts.docker ?? "ok"
				return d === "ok" ? { code: 0, out: "" } : d === "missing" ? { code: -1, out: "spawn docker ENOENT" } : d === "denied" ? { code: 1, out: "permission denied while trying to connect to the Docker daemon socket" } : { code: 1, out: "Cannot connect to the Docker daemon. Is the docker daemon running?" }
			}
			return { code: 0, out: "" }
		},
		async present(step) {
			return ready.has(step)
		},
		async install(cmd, args) {
			ran.push([cmd, ...args].join(" "))
			ready.add("installed")
			return 0
		},
		log: () => {},
	}
	return { probe, ran }
}

test("prerequisites first, in plain words: Node 24, uv, and a Docker daemon reachable without sudo", async () => {
	assert.deepEqual(await checkPrerequisites(machine().probe), [])
	assert.match((await checkPrerequisites(machine({ node: "22.11.0" }).probe)).join("\n"), /Node 24 is needed \(this is Node 22\.11\.0\)/)
	assert.match((await checkPrerequisites(machine({ uv: false }).probe)).join("\n"), /uv isn't installed: .*docs\.astral\.sh\/uv/)
	assert.match((await checkPrerequisites(machine({ docker: "down" }).probe)).join("\n"), /Docker isn't running: start it, then re-run/)
	assert.match((await checkPrerequisites(machine({ docker: "missing" }).probe)).join("\n"), /Docker isn't installed/)
	assert.match((await checkPrerequisites(machine({ docker: "denied" }).probe)).join("\n"), /without sudo/)
})

test("a failed prerequisite stops setup before anything is installed", async () => {
	const m = machine({ docker: "down" })
	const summary = await runSetup(m.probe, {})
	assert.equal(summary.ok, false)
	assert.deepEqual(m.ran, [])
})

test("on a bare machine it runs the README's install steps, in order, with the README's pins", async () => {
	const m = machine()
	const summary = await runSetup(m.probe, {})
	assert.equal(summary.ok, true)
	assert.deepEqual(m.ran, [
		"uv venv --allow-existing --python 3.12 .venv",
		"uv pip install --python .venv/bin/python platformio==6.2.0 build123d==0.13.0",
		"npm i --prefix tools/node tscircuit@0.0.3042 bun@1.4.4",
		"docker pull kicad/kicad:10.0",
		".venv/bin/pio pkg install -d templates/fw -e esp32c3",
	])
	// The same pins as the README's Install block.
	for (const pin of ["platformio==6.2.0", "build123d==0.13.0", "tscircuit@0.0.3042", "bun@1.4.4", "kicad/kicad:10.0", "-e esp32c3"]) assert.ok(README.includes(pin), pin)
	assert.equal(INSTALL.length, 4)
})

test("idempotent: what is present is skipped, and the summary says what is ready", async () => {
	const m = machine({ ready: ["python", "tscircuit", "kicad", "toolchain"] })
	const summary = await runSetup(m.probe, {})
	assert.deepEqual(m.ran, [])
	assert.deepEqual(summary.lines.slice(0, 4).map((l) => l.split(":")[0]), ["python tools (.venv)", "tscircuit + bun (tools/node)", "KiCad 10 (Docker image)", "ESP32-C3 toolchain (PlatformIO)"])
	assert.ok(summary.lines.slice(0, 4).every((l) => /already there/.test(l)), summary.lines.join("\n"))
	assert.match(summary.lines.join("\n"), /QEMU .*not installed \(optional: npm run setup -- --qemu\)/)
})

test("optional parts only behind their flags; a failed step is reported and the rest still run", async () => {
	const m = machine({ ready: ["python", "tscircuit", "kicad", "toolchain"] })
	const qemu = await runSetup(m.probe, { qemu: true })
	assert.ok(m.ran.some((c) => c.includes("esp-develop-9.2.2-20260417")), m.ran.join("\n"))
	assert.equal(qemu.ok, true)
	const failing = machine()
	failing.probe.install = async (cmd) => (cmd === "docker" ? 1 : 0)
	const s = await runSetup(failing.probe, {})
	assert.equal(s.ok, false)
	assert.match(s.lines.join("\n"), /KiCad 10 \(Docker image\): FAILED/)
	assert.match(s.lines.join("\n"), /ESP32-C3 toolchain \(PlatformIO\): installed/)
})

test("nothing in setup uses sudo or installs system-wide", () => {
	const src = readFileSync(new URL("../src/setup/setup.ts", import.meta.url), "utf8")
	assert.doesNotMatch(src, /(install|check)\("sudo"|apt(-get)? install|npm i -g|--global/)
})

test("doctor names each tool's backend and which optional settings are set, never their values", () => {
	const text = doctorReport(
		{ root: "/r", tsci: "/r/tools/node/node_modules/.bin/tsci", kicad: "docker", python: "/r/.venv/bin/python", pio: null, qemu: null },
		{ OPENAI_API_KEY: "sk-very-secret-value", WOKWI_CLI_TOKEN: "", BRINGUP_NTFY_TOPIC: "bringup-secret-topic" },
	)
	assert.match(text, /tscircuit\s+local/)
	assert.match(text, /KiCad 10\s+Docker \(kicad\/kicad:10\.0\)/)
	assert.match(text, /PlatformIO\s+missing: npm run setup/)
	assert.match(text, /QEMU\s+missing \(optional: npm run setup -- --qemu\)/)
	assert.match(text, /model key\s+set \(OPENAI_API_KEY\)/)
	assert.match(text, /WOKWI_CLI_TOKEN\s+not set/)
	assert.match(text, /BRINGUP_NTFY_TOPIC\s+set/)
	assert.ok(!text.includes("sk-very-secret-value") && !text.includes("bringup-secret-topic"))
})

// --wokwi: 5b's pinned release (src/tools/wokwi.ts), the one source of truth.
function wokwiMachine(opts: { platform?: string; files?: Record<string, string>; download?: string } = {}) {
	const m = machine({ ready: ["python", "tscircuit", "kicad", "toolchain"] })
	const files = new Map(Object.entries(opts.files ?? {}))
	const steps: string[] = []
	Object.assign(m.probe, {
		platform: opts.platform ?? "linux-x64",
		exists: async (p: string) => files.has(p),
		sha256: async (p: string) => (files.has(p) ? files.get(p)! : null),
		download: async (url: string, to: string) => {
			steps.push(`download ${url} -> ${to}`)
			files.set(to, opts.download ?? WOKWI_CLI.sha256)
			return true
		},
		place: async (from: string, to: string) => {
			steps.push(`place ${from} -> ${to} (+x)`)
			files.set(to, files.get(from)!)
			files.delete(from)
		},
		remove: async (p: string) => {
			steps.push(`remove ${p}`)
			files.delete(p)
		},
	})
	return { ...m, steps, files }
}

test("--wokwi downloads 5b's pinned CLI, checks its sha256 before putting it in place, then compiles each sensor chip", async () => {
	const m = wokwiMachine()
	const s = await runSetup(m.probe, { wokwi: true })
	assert.equal(s.ok, true, s.lines.join("\n"))
	const tmp = `${WOKWI_CLI.dest}.download`
	assert.deepEqual(m.steps, [`download ${WOKWI_CLI.url} -> ${tmp}`, `place ${tmp} -> ${WOKWI_CLI.dest} (+x)`])
	assert.deepEqual(m.ran, WOKWI_CHIPS.map((c) => `${WOKWI_CLI.dest} chip compile -o tools/wokwi-cli/chips/${c}.chip.wasm templates/wokwi/chips/${c}.chip.c`))
	assert.match(s.lines.join("\n"), new RegExp(`Wokwi CLI ${WOKWI_CLI.version.replace(/\./g, "\\.")} \\(tools/wokwi-cli\\): installed`))
})

test("--wokwi refuses a download whose sha256 doesn't match and leaves nothing in place", async () => {
	const m = wokwiMachine({ download: "0".repeat(64) })
	const s = await runSetup(m.probe, { wokwi: true })
	assert.equal(s.ok, false)
	assert.match(s.lines.join("\n"), /Wokwi CLI .*FAILED \(sha256 mismatch/)
	assert.ok(!m.files.has(WOKWI_CLI.dest))
	assert.ok(m.steps.some((x) => x.startsWith("remove ")))
	assert.deepEqual(m.ran, [])
})

test("--wokwi skips what is there: a matching binary and compiled chips", async () => {
	const files: Record<string, string> = { [WOKWI_CLI.dest]: WOKWI_CLI.sha256 }
	for (const c of WOKWI_CHIPS) files[`tools/wokwi-cli/chips/${c}.chip.wasm`] = "x"
	const m = wokwiMachine({ files })
	const s = await runSetup(m.probe, { wokwi: true })
	assert.deepEqual([m.steps, m.ran], [[], []])
	assert.match(s.lines.join("\n"), /Wokwi CLI .*: already there/)
})

test("--wokwi on anything but linux x64 says so instead of guessing another asset's checksum", async () => {
	const m = wokwiMachine({ platform: "darwin-arm64" })
	const s = await runSetup(m.probe, { wokwi: true })
	assert.match(s.lines.join("\n"), /Wokwi CLI: linux x64 only for now \(this is darwin-arm64\)/)
	assert.deepEqual([m.steps, m.ran], [[], []])
})

test("without --wokwi the summary says how to add it", async () => {
	const m = wokwiMachine()
	const s = await runSetup(m.probe, {})
	assert.match(s.lines.join("\n"), /Wokwi CLI .*not installed \(optional: npm run setup -- --wokwi, plus WOKWI_CLI_TOKEN in \.env\)/)
})

test("doctor names the firmware simulator: Wokwi when its CLI and token are there, else QEMU, else none", () => {
	const base = { root: "/r", tsci: "t", kicad: "docker" as const, python: "p", pio: "pio" }
	const sim = (env: object) => doctorReport({ ...base, ...env }, {})
	assert.match(sim({ wokwi: "/r/tools/wokwi-cli/wokwi-cli", wokwiToken: true, qemu: "/q" }), /Wokwi \(sim\)\s+local \(token set\)\n[\s\S]*firmware sim\s+→ Wokwi/)
	assert.match(sim({ wokwi: null, wokwiToken: true, qemu: "/q" }), /Wokwi \(sim\)\s+CLI missing: npm run setup -- --wokwi[\s\S]*firmware sim\s+→ QEMU/)
	assert.match(sim({ wokwi: "/w", wokwiToken: false, qemu: null }), /Wokwi \(sim\)\s+not set up \(WOKWI_CLI_TOKEN not set\)[\s\S]*firmware sim\s+→ none/)
})
