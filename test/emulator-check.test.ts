import { test } from "node:test"
import assert from "node:assert/strict"
import { join as joinPath } from "node:path"
import { createHuman } from "@mozaik-ai/core"
import { BringupState, emit, join, startRuntime } from "../src/runtime.ts"
import { createEmulatorCheck, emulatorEnabled } from "../src/agents/emulator.ts"
import { makeEvent } from "../src/events.ts"
import type { BootResult } from "../src/tools/emulator.ts"
import type { Env } from "../src/tools/env.ts"
import { fixtureArtifacts } from "./fixture.ts"
import { recorder, tempDir, waitFor } from "./helpers.ts"

const env: Env = { root: "/repo", tsci: null, kicad: null, python: null, pio: "/x/pio", qemu: "/repo/tools/qemu/bin/qemu-system-riscv32" }

function setup(boot: (root: string, dir: string) => Promise<BootResult>) {
	const state = new BringupState(tempDir())
	startRuntime(state, undefined, null)
	const events = recorder()
	const builder = createHuman({ name: "firmware-builder", capabilities: [], handlers: [] })
	join(builder)
	const check = createEmulatorCheck(env, { boot })
	join(check)
	// A firmware build finished: store the artifact and announce it, as the firmware builder does.
	const built = (revision: number, ok = true) => {
		state.artifacts.firmware = { ...fixtureArtifacts().firmware!, revision, ok }
		emit(makeEvent("artifact.ready", builder.getId(), { kind: "firmware", revision }), builder.getId())
	}
	const booted = () => events.filter((e) => e.type === "firmware.booted").map((e) => e.payload as { revision: number; booted: boolean; bootRevision: number | null; serialTail: string })
	return { state, check, built, booted }
}

const ok = (rev: number): BootResult => ({ booted: true, revision: rev, serial: `ESP-ROM:esp32c3\nbringup rev ${rev}\nSENSOR FAIL\n`, backend: "qemu" })

test("boots the firmware that was just built and reports the revision it printed", async () => {
	const dirs: string[] = []
	const t = setup(async (_root, dir) => (dirs.push(dir), ok(6)))
	t.built(6)
	await waitFor(() => t.booted().length === 1)
	assert.deepEqual(t.booted()[0], { revision: 6, booted: true, bootRevision: 6, serialTail: "ESP-ROM:esp32c3\nbringup rev 6\nSENSOR FAIL" })
	assert.deepEqual(dirs, [joinPath(t.state.outDir, "firmware", "rev-6")])
})

test("a firmware that does not boot is reported, not thrown", async () => {
	const t = setup(async () => ({ booted: false, revision: null, serial: "assert failed: init_flash", backend: "qemu" }))
	t.built(6)
	await waitFor(() => t.booted().length === 1)
	assert.equal(t.booted()[0].booted, false)
	assert.equal(t.booted()[0].bootRevision, null)
	assert.match(t.booted()[0].serialTail, /assert failed/)
})

test("a firmware that did not compile is not booted", async () => {
	let calls = 0
	const t = setup(async () => (calls++, ok(6)))
	t.built(6, false)
	await new Promise((r) => setTimeout(r, 50))
	assert.equal(calls, 0)
	assert.deepEqual(t.booted(), [])
	assert.equal(t.check.idle, true)
})

test("only the newest firmware is booted when builds arrive during a boot", async () => {
	const booted: number[] = []
	let release!: () => void
	const gate = new Promise<void>((r) => (release = r))
	const t = setup(async (_root, dir) => {
		const rev = Number(dir.split("rev-")[1])
		booted.push(rev)
		if (rev === 6) await gate
		return ok(rev)
	})
	t.built(6)
	await waitFor(() => booted.length === 1)
	t.built(7)
	t.built(8)
	assert.equal(t.check.idle, false)
	release()
	await waitFor(() => t.booted().length === 2)
	assert.deepEqual(booted, [6, 8])
	await t.check.whenIdle(1000)
})

test("enabled only with a working QEMU and real hardware", () => {
	assert.equal(emulatorEnabled(env, false), true)
	assert.equal(emulatorEnabled(env, true), false, "--no-hardware")
	assert.equal(emulatorEnabled({ ...env, qemu: null }, false), false, "QEMU missing or cannot start")
	assert.equal(emulatorEnabled({ ...env, pio: null }, false), false, "no firmware is built without PlatformIO")
})
