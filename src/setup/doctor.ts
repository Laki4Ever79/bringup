// `npm run doctor`: which backend each tool will use on this machine (src/tools/env.ts, the same detection a run
// uses) and which optional settings are present. It names settings, never prints their values.
import { providerProblem, resolveProvider } from "../inference/providers.ts"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { firmwareSimBackend, KICAD_IMAGE, type Env } from "../tools/env.ts"
import { VENDOR_PLATFORMS } from "./setup.ts"


// What the other vendors need (docs/mcu.md), found on disk by vendorStatus: PlatformIO platforms and ST's pin data.
export interface VendorStatus {
	platforms: Record<string, boolean>
	stPinData: boolean
	// MuJoCo in .venv (npm run setup): robots' simulated drive only.
	mujoco?: boolean
}

// A package in .venv, found on disk (no Python start): .venv/lib/python3.x/site-packages/<name>.
function venvHas(root: string, pkg: string): boolean {
	const lib = join(root, ".venv/lib")
	try {
		return readdirSync(lib).some((d) => existsSync(join(lib, d, "site-packages", pkg)))
	} catch {
		return false
	}
}

export function vendorStatus(root: string, pioHome = process.env.PLATFORMIO_CORE_DIR ?? join(homedir(), ".platformio")): VendorStatus {
	return {
		platforms: Object.fromEntries(VENDOR_PLATFORMS.map((spec) => [spec, existsSync(join(pioHome, "platforms", spec.replace(/^platformio\//, "").replace(/@.*/, "")))])),
		stPinData: existsSync(join(root, "tools/vendor/STM32_open_pin_data/mcu")),
		mujoco: venvHas(root, "mujoco"),
	}
}

export function doctorReport(env: Env, vars: Record<string, string | undefined>, vendors?: VendorStatus): string {
	const set = (name: string) => Boolean(vars[name]?.trim())
	const row = (label: string, value: string) => `${label.padEnd(20)}${value}`
	const tool = (path: string | null | undefined, missing = "missing: npm run setup") => (path ? "local" : missing)
	const ai = resolveProvider(vars)
	const aiProblem = providerProblem(vars)
	return [
		"Tools (what a run will use)",
		row("tscircuit", tool(env.tsci)),
		row("KiCad 10", env.kicad === "local" ? "local kicad-cli" : env.kicad === "docker" ? `Docker (${KICAD_IMAGE})` : "missing: npm run setup (needs Docker)"),
		row("python/build123d", tool(env.python)),
		row("PlatformIO", tool(env.pio)),
		row("QEMU", ((have) => (have.length ? `local (${have.join(", ")})` : "missing (robots: npm run setup -- --robotics)"))(["riscv32", "xtensa"].filter((a) => existsSync(join(env.root, `tools/qemu/bin/qemu-system-${a}`))).map((a) => (a === "riscv32" ? "ESP32-C3" : "ESP32-S3")))),
		row("Wokwi (sim)", !env.wokwi ? "CLI missing: npm run setup -- --wokwi" : env.wokwiToken ? "local (token set)" : "not set up (WOKWI_CLI_TOKEN not set)"),
		row("poppler (PDF)", env.poppler ? "local" : "missing (optional: part learning needs pdfinfo, pdftotext, pdftoppm)"),
		row("Renode (STM32/nRF)", env.renode ? "local" : "missing (optional: npm run setup -- --renode)"),
		...(vendors
			? [
					...Object.entries(vendors.platforms).map(([spec, ok]) => row(`pio ${spec.replace(/^platformio\//, "").replace(/@.*/, "")}`, ok ? "installed" : `missing (optional: npm run setup -- --vendors, ${spec})`)),
					row("MuJoCo (robots)", vendors.mujoco ? "local (.venv)" : "missing (robots: npm run setup -- --robotics; only robots' simulated drive)"),
					row("ST pin data", vendors.stPinData ? "local (tools/vendor)" : "missing (optional: npm run setup -- --vendors; only to regenerate STM32 profiles)"),
				]
			: []),
		row("firmware sim", `→ ${{ wokwi: "Wokwi", qemu: "QEMU", none: "none" }[firmwareSimBackend(env) ?? "none"]}`),
		"",
		"Settings (from the environment or .env; values are never shown)",
		row("AI", ai && !aiProblem ? `${ai.label}${ai.keyVar && !ai.local ? ` (${ai.keyVar} set)` : ""}` : ai ? `${ai.label}: ${aiProblem}` : "not set: scripted mode only (--mock); BRINGUP_AI picks one (see docs/ai.md)"),
		row("WOKWI_CLI_TOKEN", set("WOKWI_CLI_TOKEN") ? "set" : "not set (optional: Wokwi simulation)"),
		row("BRINGUP_NTFY_TOPIC", set("BRINGUP_NTFY_TOPIC") ? "set" : "not set (optional: phone approvals)"),
	].join("\n")
}
