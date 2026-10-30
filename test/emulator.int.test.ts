import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { bootFirmware } from "../src/tools/emulator.ts"
import { buildFirmware } from "../src/tools/firmware.ts"
import { fixtureContract } from "./fixture.ts"

const root = resolve(import.meta.dirname, "..")
const toolsRoot = existsSync(join(root, "tools/qemu/bin/qemu-system-riscv32")) ? root : undefined
const pio = [join(root, ".venv/bin/pio")].find(existsSync)
const skip = !toolsRoot ? "tools/qemu not installed" : !pio ? "pio not found" : false

test("fixture firmware boots in QEMU and reports the contract revision", { skip, timeout: 600_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "bringup-emu-"))
	try {
		const c = fixtureContract()
		const firmware = await buildFirmware(pio!, root, dir, c, c.revision)
		assert.equal(firmware.ok, true, firmware.log)
		const boot = await bootFirmware(toolsRoot!, dir)
		assert.equal(boot.backend, "qemu")
		assert.equal(boot.booted, true, boot.serial)
		assert.equal(boot.revision, c.revision)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test("booting a directory with no build returns booted:false instead of throwing", { skip, timeout: 60_000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "bringup-emu-"))
	try {
		const boot = await bootFirmware(toolsRoot!, dir, 2000)
		assert.equal(boot.booted, false)
		assert.equal(boot.revision, null)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
