// The firmware a CNC actually runs, built from the contract (docs/cnc.md gap 11; lead-2, 28 Nov 2026: "firmware
// compiles" must mean the machine's own firmware, not Bringup's Arduino app). grblHAL: its STM32F4xx board build from
// the generated map (grblhal-build.ts, env bringup_cnc). FluidNC: its wifi build for the classic ESP32 in a copy of
// tools/FluidNC, and the LittleFS image holding the board's config.yaml (FluidNC reads it from flash at boot). "not
// run" when the clone or the platform isn't installed: FluidNC's pinned pioarduino platform is +2.86 GB (measured 27
// Nov), pulled only for FluidNC designs (docs/backlog.md, the user's lean-dependencies item).
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { ContractSnapshot } from "../contract/types.ts"
import { fluidncConfig } from "../cnc/fluidnc.ts"
import { grblhalMcuProblem } from "../cnc/grblhal.ts"
import { defaultCheckCatalog } from "../mechanics/checks.ts"
import { buildGrblhal, grblhalReady } from "./grblhal-build.ts"
import { run } from "./exec.ts"

export interface MachineFwArtifact {
	revision: number
	dir: string
	firmware: "grblhal" | "fluidnc" | null
	result: "built" | "failed" | "not run"
	reason?: string
	// PlatformIO's RAM and flash use, percent.
	ramPct?: number
	flashPct?: number
	ms?: number
	image?: string // the firmware binary or elf
	fsImage?: string // FluidNC's LittleFS image with config.yaml
}

export const fluidncClone = (root: string) => join(root, "tools/FluidNC")
// FluidNC's platform, pinned in its platformio.ini (pioarduino platform-espressif32 55.03.39).
const FLUIDNC_PLATFORM = "55.03.39"
export function fluidncReady(root: string): boolean {
	if (!existsSync(join(fluidncClone(root), "platformio.ini")) || !existsSync(join(root, ".venv/bin/pio"))) return false
	const core = process.env.PLATFORMIO_CORE_DIR ?? join(homedir(), ".platformio")
	try {
		return String(JSON.parse(readFileSync(join(core, "platforms/espressif32/platform.json"), "utf8")).version).startsWith(FLUIDNC_PLATFORM)
	} catch {
		return false
	}
}

// "RAM:   [==        ]  20.9% (used ...)" and "Flash: [...]  97.1% (...)" from PlatformIO's size report.
export function pioSizes(out: string): { ramPct?: number; flashPct?: number } {
	const pct = (what: string) => {
		const m = new RegExp(`${what}:\\s*\\[[^\\]]*\\]\\s*([\\d.]+)%`).exec(out)
		return m ? Number(m[1]) : undefined
	}
	return { ramPct: pct("RAM"), flashPct: pct("Flash") }
}

// The first lines of a failed build that say why (a compiler error, a missing file), for the report and the owner.
const firstError = (out: string) => (out.split("\n").filter((l) => /error:|Error \d|FAILED|No such file/.test(l)).slice(0, 4).join("; ") || out.trim().split("\n").slice(-3).join("; ")).slice(0, 600)

// FluidNC's libraries, by the folder each installs into: its platformio.ini's lib_deps for the wifi env (TMCStepper
// from the registry, two from GitHub). Builds that copied the clone without them downloaded all six every time, and
// one download failing (TMCStepper, 28 Nov 2026, beside another PlatformIO build) failed the build in 11 s.
export const FLUIDNC_LIBS = ["TMCStepper", "JsonStreamingParser", "AsyncTCP", "ESPAsyncWebServer", "Unity", "ESP8266 and ESP32 OLED driver for SSD1306 displays"]
export const libdepsComplete = (dir: string) => FLUIDNC_LIBS.every((l) => existsSync(join(dir, l)))
// The clone's copy for a build: everything but an earlier build's output (its installed libraries come along).
export const fluidncCopyFilter = (p: string) => !/[/\\]\.pio[/\\]build$/.test(p)
// A build's complete libraries into the clone, when the clone's are incomplete: written beside and renamed in, so a
// build copying the clone meanwhile never sees half a folder.
export function seedLibdeps(from: string, to: string): boolean {
	if (!libdepsComplete(from) || libdepsComplete(to)) return false
	const tmp = `${to}.seeding-${process.pid}`
	try {
		mkdirSync(dirname(to), { recursive: true })
		cpSync(from, tmp, { recursive: true })
		rmSync(to, { recursive: true, force: true })
		renameSync(tmp, to)
		return true
	} catch {
		rmSync(tmp, { recursive: true, force: true })
		return false
	}
}

export async function buildMachineFirmware(root: string, s: ContractSnapshot, dir: string): Promise<Omit<MachineFwArtifact, "revision" | "dir">> {
	const fw = s.values.cnc?.firmware ?? null
	const t0 = Date.now()
	if (fw === "grblhal") {
		const mcu = grblhalMcuProblem(s.values.parts ?? [])
		if (mcu) return { firmware: fw, result: "not run", reason: mcu }
		if (!grblhalReady(root)) return { firmware: fw, result: "not run", reason: "grblHAL's STM32F4xx clone (tools/grblhal-STM32F4xx) or PlatformIO isn't installed: the machine's firmware isn't built" }
		const r = buildGrblhal({ root, dir, s, env: "bringup_cnc" })
		return r.ok ? { firmware: fw, result: "built", ...pioSizes(r.out), ms: Date.now() - t0, image: r.elf } : { firmware: fw, result: "failed", reason: firstError(r.out), ms: Date.now() - t0 }
	}
	if (fw === "fluidnc") {
		if (!fluidncReady(root)) return { firmware: fw, result: "not run", reason: `FluidNC's clone (tools/FluidNC) or its pinned platform (pioarduino ${FLUIDNC_PLATFORM}, about 2.9 GB on disk) isn't installed: the machine's firmware isn't built` }
		const cat = defaultCheckCatalog()
		const config = cat ? fluidncConfig(s, cat.mech) : null
		if (!config) return { firmware: fw, result: "failed", reason: "no config.yaml: the machine's pins or numbers are incomplete" }
		const src = join(dir, "fluidnc-src")
		mkdirSync(dir, { recursive: true })
		// The clone with its .git (its version script reads it) and its installed libraries, without an earlier build.
		cpSync(fluidncClone(root), src, { recursive: true, filter: fluidncCopyFilter })
		mkdirSync(join(src, "FluidNC/data"), { recursive: true })
		writeFileSync(join(src, "FluidNC/data/config.yaml"), config)
		// Its build flags run `python git-version.py`: the venv's python first on PATH (there is no bare `python` beside it).
		const env = { PATH: `${join(root, ".venv/bin")}:${process.env.PATH ?? ""}` }
		const pio = join(root, ".venv/bin/pio")
		const bin = join(src, ".pio/build/wifi/firmware.bin")
		let b = await run(pio, ["run", "-e", "wifi"], { cwd: src, timeoutMs: 30 * 60_000, env })
		// A library that failed to download (the registry, GitHub, another PlatformIO beside it) fails the build before
		// it compiles anything: once more, while the libraries are incomplete.
		if ((b.code !== 0 || !existsSync(bin)) && !libdepsComplete(join(src, ".pio/libdeps/wifi"))) b = await run(pio, ["run", "-e", "wifi"], { cwd: src, timeoutMs: 30 * 60_000, env })
		const out = b.stdout + b.stderr
		if (b.code !== 0 || !existsSync(bin)) return { firmware: fw, result: "failed", reason: firstError(out), ms: Date.now() - t0 }
		// The first build's complete libraries go back into the clone: later builds copy them and download nothing.
		seedLibdeps(join(src, ".pio/libdeps/wifi"), join(fluidncClone(root), ".pio/libdeps/wifi"))
		const fs = await run(pio, ["run", "-e", "wifi", "-t", "buildfs"], { cwd: src, timeoutMs: 10 * 60_000, env })
		const fsImage = join(src, ".pio/build/wifi/littlefs.bin")
		return { firmware: fw, result: "built", ...pioSizes(out), ms: Date.now() - t0, image: bin, ...(fs.code === 0 && existsSync(fsImage) ? { fsImage } : {}) }
	}
	return { firmware: fw, result: "not run", reason: "the machine names no firmware (cnc.firmware)" }
}

export function machineFwLines(a: MachineFwArtifact | undefined): string[] {
	if (!a) return []
	const name = a.firmware === "fluidnc" ? "FluidNC" : a.firmware === "grblhal" ? "grblHAL" : "firmware"
	if (a.result === "not run") return [`- Machine firmware (${name}): not built (${a.reason})`]
	if (a.result === "failed") return [`- Machine firmware (${name}, rev ${a.revision}): does NOT build: ${a.reason}`]
	const size = [a.ramPct !== undefined ? `RAM ${a.ramPct}%` : null, a.flashPct !== undefined ? `flash ${a.flashPct}%` : null].filter(Boolean).join(", ")
	return [`- Machine firmware (${name}, rev ${a.revision}): builds${size ? `, ${size}` : ""}${a.ms !== undefined ? ` in ${Math.round(a.ms / 1000)} s` : ""}${a.fsImage ? "; config.yaml in its LittleFS image" : ""}`]
}
