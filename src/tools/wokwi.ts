import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { SIM_READING, wokwiProject } from "../codegen/wokwi.ts"
import type { ContractSnapshot } from "../contract/types.ts"
import { firmwareSimBackend, type Env } from "./env.ts"
import { mergeFlash } from "./emulator.ts"
import { run, tail } from "./exec.ts"

// Wokwi simulation of a built firmware, on demand only (the free plan has 50 min per 30 days, 5 min per session): the
// circuit is generated from the contract (codegen/wokwi.ts), the sensor is a custom chip that answers a known reading,
// and the run passes when the firmware prints that reading and stores it.

// The pinned Wokwi CLI (NOTES.md; `npm run setup -- --wokwi` installs it from here): GitHub's release binary, checked
// against GitHub's published sha256 before it is used, repo-local.
export const WOKWI_CLI = {
	version: "0.29.1",
	url: "https://github.com/wokwi/wokwi-cli/releases/download/v0.29.1/wokwi-cli-linuxstatic-x64",
	sha256: "3c9d6da007d008a3822ab468318037285440055132c59fd659d7306e40f14258",
	dest: "tools/wokwi-cli/wokwi-cli",
} as const
// The sensor stand-ins to compile once per machine: `<dest> chip compile -o tools/wokwi-cli/chips/<name>.chip.wasm
// templates/wokwi/chips/<name>.chip.c` (it installs a WASI-SDK into ~/.wokwi on first use).
export const WOKWI_CHIPS = ["sht40", "shtc3"] as const

export const SIM_TIMEOUT_MS = 30_000
export const EXPECTED_LINE = `SENSOR OK ${SIM_READING.tempC.toFixed(2)} C ${SIM_READING.rh.toFixed(1)} %RH`

export interface SimResult {
	ran: boolean
	// Why it did not run, in words (never the token).
	reason?: string
	passed?: boolean
	serial?: string
}

// The custom chips, compiled to WASM once per machine (NOTES.md), live beside the CLI.
export const chipWasm = (root: string, chip: string) => join(root, "tools/wokwi-cli/chips", `${chip}.chip.wasm`)

export async function simulateFirmware(env: Env, fwDir: string, s: ContractSnapshot, opts: { timeoutMs?: number } = {}): Promise<SimResult> {
	if (firmwareSimBackend(env) !== "wokwi") {
		const reason = !env.wokwiToken ? "no WOKWI_CLI_TOKEN in .env" : "wokwi-cli is not installed in tools/wokwi-cli"
		return { ran: false, reason: `${reason}; optional, see NOTES.md` }
	}
	if (!existsSync(join(fwDir, ".pio/build/esp32c3/firmware.bin"))) return { ran: false, reason: "the firmware has not been built" }
	const { image, log } = await mergeFlash(fwDir)
	if (!image) return { ran: false, reason: `could not merge the flash image: ${tail(log, 3)}` }
	const project = join(fwDir, "wokwi")
	const p = wokwiProject(s, "../.pio/build/esp32c3")
	if (p.chip && !existsSync(chipWasm(env.root, p.chip))) return { ran: false, reason: `the ${p.chip} custom chip is not compiled (tools/wokwi-cli/chips, see NOTES.md)` }
	mkdirSync(join(project, "chips"), { recursive: true })
	writeFileSync(join(project, "wokwi.toml"), p.toml)
	writeFileSync(join(project, "diagram.json"), p.diagram)
	if (p.chip) {
		copyFileSync(chipWasm(env.root, p.chip), join(project, "chips", `${p.chip}.chip.wasm`))
		copyFileSync(join(env.root, "templates/wokwi/chips", `${p.chip}.chip.json`), join(project, "chips", `${p.chip}.chip.json`))
	}
	const timeoutMs = opts.timeoutMs ?? SIM_TIMEOUT_MS
	// The CLI reads WOKWI_CLI_TOKEN from the environment it inherits; it is never put on the command line.
	// A fresh simulated flash: the first reading goes to slot 0; -1 means the store failed.
	const r = await run(env.wokwi!, [project, "--timeout", String(timeoutMs), "--expect-text", "HISTORY slot 0", "--fail-text", "HISTORY slot -1"], { timeoutMs: timeoutMs + 150_000 }) // the upload of the 4 MB flash image comes first; only the simulation counts against the plan
	const serial = `${r.stdout}\n${r.stderr}`
	return { ran: true, passed: r.code === 0 && serial.includes(EXPECTED_LINE), serial: tail(serial, 40) }
}
