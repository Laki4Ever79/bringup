// `npm run doctor`: which backend each tool will use on this machine (src/tools/env.ts, the same detection a run
// uses) and which optional settings are present. It names settings, never prints their values.
import { firmwareSimBackend, KICAD_IMAGE, type Env } from "../tools/env.ts"

const MODEL_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"]

export function doctorReport(env: Env, vars: Record<string, string | undefined>): string {
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
		row("firmware sim", `→ ${{ wokwi: "Wokwi", qemu: "QEMU", none: "none" }[firmwareSimBackend(env) ?? "none"]}`),
		"",
		"Settings (from the environment or .env; values are never shown)",
		row("model key", keys.length ? `set (${keys.join(", ")})` : "not set: scripted mode only (--mock)"),
		row("WOKWI_CLI_TOKEN", set("WOKWI_CLI_TOKEN") ? "set" : "not set (optional: Wokwi simulation)"),
		row("BRINGUP_NTFY_TOPIC", set("BRINGUP_NTFY_TOPIC") ? "set" : "not set (optional: phone approvals)"),
	].join("\n")
}
