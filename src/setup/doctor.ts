// `npm run doctor`: which backend each tool will use on this machine (src/tools/env.ts, the same detection a run
// uses) and which optional settings are present. It names settings, never prints their values.
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { firmwareSimBackend, KICAD_IMAGE, type Env } from "../tools/env.ts"
import { VENDOR_PLATFORMS } from "./setup.ts"

const MODEL_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"]

// What the other vendors need (docs/mcu.md), found on disk by vendorStatus: PlatformIO platforms and ST's pin data.
export interface VendorStatus {
	platforms: Record<string, boolean>
	stPinData: boolean
}

export function vendorStatus(root: string, pioHome = process.env.PLATFORMIO_CORE_DIR ?? join(homedir(), ".platformio")): VendorStatus {
	return {
		platforms: Object.fromEntries(VENDOR_PLATFORMS.map((spec) => [spec, existsSync(join(pioHome, "platforms", spec.replace(/^platformio\//, "").replace(/@.*/, "")))])),
		stPinData: existsSync(join(root, "tools/vendor/STM32_open_pin_data/mcu")),
	}
}

export function doctorReport(env: Env, vars: Record<string, string | undefined>, vendors?: VendorStatus): string {
	const set = (name: string) => Boolean(vars[name]?.trim())
	const row = (label: string, value: string) => `${label.padEnd(20)}${value}`
	const tool = (path: string | null | undefined, missing = "missing: npm run setup") => (path ? "local" : missing)
	const keys = MODEL_KEYS.filter(set)
	return [
		"Tools (what a run will use)",
		row("tscircuit", tool(env.tsci)),
		row("KiCad 10", env.kicad === "local" ? "local kicad-cli" : env.kicad === "docker" ? `Docker (${KICAD_IMAGE})` : "missing: npm run setup (needs Docker)"),
		row("python/build123d", tool(env.python)),
		row("PlatformIO", tool(env.pio)),
		row("QEMU", env.qemu ? "local" : "missing (optional: npm run setup -- --qemu)"),
		row("Wokwi (sim)", !env.wokwi ? "CLI missing: npm run setup -- --wokwi" : env.wokwiToken ? "local (token set)" : "not set up (WOKWI_CLI_TOKEN not set)"),
		row("poppler (PDF)", env.poppler ? "local" : "missing (optional: part learning needs pdfinfo, pdftotext, pdftoppm)"),
		row("Renode (STM32/nRF)", env.renode ? "local" : "missing (optional: npm run setup -- --renode)"),
		...(vendors
			? [
					...Object.entries(vendors.platforms).map(([spec, ok]) => row(`pio ${spec.replace(/^platformio\//, "").replace(/@.*/, "")}`, ok ? "installed" : `missing (optional: npm run setup -- --vendors, ${spec})`)),
					row("ST pin data", vendors.stPinData ? "local (tools/vendor)" : "missing (optional: npm run setup -- --vendors; only to regenerate STM32 profiles)"),
				]
			: []),
		row("firmware sim", `→ ${{ wokwi: "Wokwi", qemu: "QEMU", none: "none" }[firmwareSimBackend(env) ?? "none"]}`),
		"",
		"Settings (from the environment or .env; values are never shown)",
		row("model key", keys.length ? `set (${keys.join(", ")})` : "not set: scripted mode only (--mock)"),
		row("WOKWI_CLI_TOKEN", set("WOKWI_CLI_TOKEN") ? "set" : "not set (optional: Wokwi simulation)"),
		row("BRINGUP_NTFY_TOPIC", set("BRINGUP_NTFY_TOPIC") ? "set" : "not set (optional: phone approvals)"),
	].join("\n")
}
