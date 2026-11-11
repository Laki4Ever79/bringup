import type { Env } from "../tools/env.ts"
import type { McuProfile } from "./profile.ts"

// Which simulator boots this chip's firmware here (docs/mcu.md, Simulation): the profile names the backend that models
// the chip (Espressif's QEMU for the ESP32-C3, Renode for STM32 and nRF52), the machine decides whether it is
// installed. A chip no simulator models says so as a reason, so a run reports a skipped check, not a failed boot.

export type SimBackend = "qemu" | "wokwi" | "renode"

export function simBackendFor(p: McuProfile | null, env: Pick<Env, "qemu" | "wokwi" | "wokwiToken" | "renode">): { backend: SimBackend | null; reason: string } {
	const want = p ? p.sim.backend : "qemu"
	const chip = p?.mpn ?? "ESP32-C3"
	if (want === null) return { backend: null, reason: `no simulator for the ${chip}${p?.sim.note ? `: ${p.sim.note}` : ""}` }
	if (want === "qemu") {
		if (env.wokwi && env.wokwiToken) return { backend: "wokwi", reason: `Wokwi (CLI and token set) runs the ${chip}` }
		return env.qemu ? { backend: "qemu", reason: `Espressif QEMU boots the ${chip}` } : { backend: null, reason: `Espressif QEMU is not installed (npm run setup) for the ${chip}` }
	}
	return env.renode ? { backend: "renode", reason: `Renode boots the ${chip} (${p?.sim.machine})` } : { backend: null, reason: `Renode is not installed (npm run setup) for the ${chip}` }
}
