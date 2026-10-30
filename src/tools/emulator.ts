import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// Boots a buildFirmware output in Espressif's QEMU fork (machine esp32c3) and captures its serial port.
// Wokwi CLI is the other backend (it can also fake the SHT40), but it needs a WOKWI_CLI_TOKEN we don't have.

export interface BootResult {
	booted: boolean
	serial: string
	revision: number | null
	backend: "qemu"
}

// Arduino-ESP32 flash layout for the ESP32-C3: offsets match what `pio run -t upload` writes.
const FLASH_SIZE = "4MB"
const SERIAL_LIMIT = 64_000

function esptoolPath(): string {
	const core = process.env.PLATFORMIO_CORE_DIR ?? join(homedir(), ".platformio")
	return join(core, "packages/tool-esptool/esptool")
}

function bootApp0Path(): string {
	const core = process.env.PLATFORMIO_CORE_DIR ?? join(homedir(), ".platformio")
	return join(core, "packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin")
}

function run(cmd: string, args: string[], timeoutMs: number, until?: RegExp, env?: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
	return new Promise((resolve) => {
		let output = ""
		let done = false
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: env ?? process.env })
		const finish = (code: number | null) => {
			if (done) return
			done = true
			clearTimeout(timer)
			child.kill("SIGKILL")
			resolve({ code, output })
		}
		const timer = setTimeout(() => finish(null), timeoutMs)
		const onData = (d: Buffer) => {
			output = (output + d).slice(-SERIAL_LIMIT)
			if (until?.test(output)) finish(null)
		}
		child.stdout.on("data", onData)
		child.stderr.on("data", onData)
		child.on("error", (e) => { output += `\n${e.message}`; finish(null) })
		child.on("close", (code) => finish(code))
	})
}

// Merges bootloader, partitions, boot_app0 and the app into one image QEMU can mount as flash.
async function mergeFlash(fwDir: string): Promise<{ image: string | null; log: string }> {
	const build = join(fwDir, ".pio/build/esp32c3")
	const parts: [string, string][] = [
		["0x0", join(build, "bootloader.bin")],
		["0x8000", join(build, "partitions.bin")],
		["0xe000", bootApp0Path()],
		["0x10000", join(build, "firmware.bin")],
	]
	const missing = parts.filter(([, p]) => !existsSync(p)).map(([, p]) => p)
	if (missing.length) return { image: null, log: `missing build output: ${missing.join(", ")}` }
	const image = join(build, "flash.bin")
	const args = ["--chip", "esp32c3", "merge-bin", "-o", image, "--pad-to-size", FLASH_SIZE, ...parts.flat()]
	const { code, output } = await run(esptoolPath(), args, 60_000)
	return { image: code === 0 ? image : null, log: output }
}

export async function bootFirmware(root: string, fwDir: string, timeoutMs = 15000): Promise<BootResult> {
	const qemu = join(root, "tools/qemu/bin/qemu-system-riscv32")
	if (!existsSync(qemu)) return { booted: false, serial: `qemu not found at ${qemu}`, revision: null, backend: "qemu" }
	const { image, log } = await mergeFlash(fwDir)
	if (!image) return { booted: false, serial: log, revision: null, backend: "qemu" }
	const args = [
		// -nographic, not "-display none -serial stdio": with the latter the ESP32-C3's UART0 never reaches stdout.
		"-nographic", "-machine", "esp32c3", "-icount", "3",
		"-drive", `file=${image},if=mtd,format=raw`,
		"-global", "driver=timer.esp32c3.timg,property=wdt_disable,value=true",
	]
	// Stop at the first sensor line: by then the boot banner and setup() have run.
	// Espressif's prebuilt QEMU links libslirp, which many machines lack; NOTES.md installs it into tools/qemu/lib.
	const lib = join(root, "tools/qemu/lib")
	const env = { ...process.env, LD_LIBRARY_PATH: [lib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") }
	const { output } = await run(qemu, args, timeoutMs, /SENSOR (OK|FAIL)/, env)
	const m = output.match(/bringup rev (\d+)/)
	return { booted: m !== null, serial: output, revision: m ? Number(m[1]) : null, backend: "qemu" }
}
