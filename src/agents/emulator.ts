import { join } from "node:path"
import { createHuman, type Human } from "@mozaik-ai/core"
import { when } from "../change-control.ts"
import { isEvent, makeEvent } from "../events.ts"
import { emit, state } from "../runtime.ts"
import { mcuProfileOf } from "../mcu/profile.ts"
import { simBackendFor } from "../mcu/sim.ts"
import { bootFirmware } from "../tools/emulator.ts"
import type { Env } from "../tools/env.ts"
import { tail } from "../tools/exec.ts"
import { Rebuilder } from "../tools/rebuilder.ts"

const SERIAL_TAIL_LINES = 12

// Booting needs a firmware build (PlatformIO) and a simulator that starts (QEMU for the ESP32-C3, Renode for STM32 and
// nRF52); --no-hardware has neither. Which one a design needs is decided per boot, from its chip (simBackendFor).
export function emulatorEnabled(env: Env, noHardware: boolean): boolean {
	return !noHardware && Boolean(env.pio) && Boolean(env.qemu || env.renode)
}

export interface EmulatorCheck extends Human {
	readonly idle: boolean
	// Resolves once no boot is running or queued, or after timeoutMs.
	whenIdle(timeoutMs: number): Promise<void>
}

// A plain-code participant: after each compiled firmware build it boots the firmware in Espressif's QEMU and reports
// firmware.booted. Boots are coalesced like builds, so only the newest firmware is booted. It is not an artifact, so
// it never holds up settling.
export function createEmulatorCheck(env: Env, opts: { boot?: typeof bootFirmware } = {}): EmulatorCheck {
	const boot = opts.boot ?? bootFirmware
	const self = { id: "" }
	const rebuilder = new Rebuilder(async (revision) => {
		const s = state()
		const firmware = s.artifacts.firmware
		// Skip a firmware that didn't compile, and one a newer build has already replaced.
		if (!firmware?.ok || firmware.revision !== revision) return
		// A robot's board build talks over USB, which QEMU doesn't show: the simulated drive boots its simulation build
		// in QEMU and runs the control loop, which proves more (docs/mechanics.md).
		const v = s.contract.snapshot().values
		if (v.mechanics && v.motion) return
		// The firmware builder builds revision N in <out>/firmware/rev-N.
		// The chip's simulator; a chip none models (or one not installed here) is skipped, not reported as a failed boot.
		const profile = mcuProfileOf(v.parts)
		// (Wokwi runs on demand elsewhere; this check boots the ESP32-C3 in QEMU as it always did.)
		const sim = simBackendFor(profile, { ...env, wokwi: null })
		if (!sim.backend) return
		const r = await boot(env.root, join(s.outDir, "firmware", `rev-${revision}`), undefined, profile)
		const payload = { revision, booted: r.booted, bootRevision: r.revision, serialTail: tail(r.serial, SERIAL_TAIL_LINES), backend: r.backend }
		emit(makeEvent("firmware.booted", self.id, payload), self.id)
	})
	const participant = createHuman({
		name: "emulator",
		capabilities: [],
		handlers: [
			{
				specification: when(({ event }) => isEvent(event, "artifact.ready") && event.payload.kind === "firmware"),
				processor: {
					apply: ({ event }) => {
						if (isEvent(event, "artifact.ready")) rebuilder.request(event.payload.revision)
					},
				},
			},
		],
	})
	self.id = participant.getId()
	// A live getter: Object.assign would copy idle's value once.
	Object.defineProperty(participant, "idle", { get: () => rebuilder.idle })
	return Object.assign(participant, {
		async whenIdle(timeoutMs: number) {
			const end = Date.now() + timeoutMs
			while (!rebuilder.idle && Date.now() < end) await new Promise((r) => setTimeout(r, 100))
		},
	}) as EmulatorCheck
}
