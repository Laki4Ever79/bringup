import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { envFor } from "../mcu/firmware.ts"
import type { McuProfile } from "../mcu/profile.ts"
import { qemuEnv } from "./env.ts"
import { consoleLines, renodeScript, runRenode } from "./renode.ts"

// Boots a buildFirmware output in Espressif's QEMU fork (machine esp32c3) and captures its serial port.
// Wokwi CLI is the other backend (it can also fake the SHT40), but it needs a WOKWI_CLI_TOKEN we don't have.

export interface BootResult {
	booted: boolean
	serial: string
	revision: number | null
	backend: "qemu" | "renode"
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
export async function mergeFlash(fwDir: string, env = "esp32c3"): Promise<{ image: string | null; log: string }> {
	const build = join(fwDir, ".pio/build", env)
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

// Runs a merged flash image in QEMU (machine esp32c3) until `until` matches UART0's output, or the timeout. Time inside
// is virtual (-icount): don't read timings from it. null when QEMU isn't installed.
export async function runImage(root: string, image: string, until: RegExp, timeoutMs: number): Promise<string | null> {
	const qemu = join(root, "tools/qemu/bin/qemu-system-riscv32")
	if (!existsSync(qemu)) return null
	const args = [
		// -nographic, not "-display none -serial stdio": with the latter the ESP32-C3's UART0 never reaches stdout.
		"-nographic", "-machine", "esp32c3", "-icount", "3",
		"-drive", `file=${image},if=mtd,format=raw`,
		"-global", "driver=timer.esp32c3.timg,property=wdt_disable,value=true",
	]
	return (await run(qemu, args, timeoutMs, until, { ...process.env, ...qemuEnv(root) })).output
}

// Boots a build in the simulator its chip's profile names: Renode for STM32 and nRF52 (the ELF of the profile's env),
// Espressif QEMU for the ESP32-C3 (no profile: a design from before profiles).
export async function bootFirmware(root: string, fwDir: string, timeoutMs = 15000, profile?: McuProfile | null): Promise<BootResult> {
	if (profile && profile.sim.backend === "renode") return bootRenode(root, fwDir, profile, timeoutMs)
	const qemu = join(root, "tools/qemu/bin/qemu-system-riscv32")
	if (!existsSync(qemu)) return { booted: false, serial: `qemu not found at ${qemu}`, revision: null, backend: "qemu" }
	const { image, log } = await mergeFlash(fwDir)
	if (!image) return { booted: false, serial: log, revision: null, backend: "qemu" }
	// Stop at the first sensor line: by then the boot banner and setup() have run.
	const output = (await runImage(root, image, /SENSOR (OK|FAIL)/, timeoutMs)) ?? ""
	const m = output.match(/bringup rev (\d+)/)
	return { booted: m !== null, serial: output, revision: m ? Number(m[1]) : null, backend: "qemu" }
}

// Two boards joined by a cable, in QEMU: board A's UART1 listens on a local TCP port and board B's connects to it, so
// what one sends on its link UART the other receives (docs/system.md, the link test). Each UART0 goes to its own
// file; both are returned once each prints `until` or the timeout passes. Time inside is virtual (-icount).
export async function runLinkedPair(root: string, imageA: string, imageB: string, workDir: string, until: RegExp, timeoutMs: number): Promise<{ a: string; b: string } | null> {
	const qemu = join(root, "tools/qemu/bin/qemu-system-riscv32")
	if (!existsSync(qemu)) return null
	const { readFileSync, rmSync } = await import("node:fs")
	const { createServer } = await import("node:net")
	// A free port, picked by the OS.
	const port = await new Promise<number>((resolve) => {
		const s = createServer().listen(0, "127.0.0.1", () => {
			const p = (s.address() as { port: number }).port
			s.close(() => resolve(p))
		})
	})
	const env = { ...process.env, ...qemuEnv(root) }
	const outA = join(workDir, "uart0-a.txt")
	const outB = join(workDir, "uart0-b.txt")
	for (const f of [outA, outB]) rmSync(f, { force: true })
	const args = (image: string, out: string, uart1: string) => ["-display", "none", "-machine", "esp32c3", "-icount", "3", "-drive", `file=${image},if=mtd,format=raw`, "-global", "driver=timer.esp32c3.timg,property=wdt_disable,value=true", "-serial", `file:${out}`, "-serial", uart1]
	const a = spawn(qemu, args(imageA, outA, `tcp:127.0.0.1:${port},server=on,wait=on`), { stdio: "ignore", env })
	// B connects once A listens; A waits for it before it starts (wait=on), so both start together.
	await new Promise((r) => setTimeout(r, 500))
	const b = spawn(qemu, args(imageB, outB, `tcp:127.0.0.1:${port}`), { stdio: "ignore", env })
	const read = (f: string) => (existsSync(f) ? readFileSync(f, "latin1") : "")
	const deadline = Date.now() + timeoutMs
	try {
		while (Date.now() < deadline && !(until.test(read(outA)) && until.test(read(outB)))) await new Promise((r) => setTimeout(r, 250))
	} finally {
		a.kill("SIGKILL")
		b.kill("SIGKILL")
	}
	return { a: read(outA), b: read(outB) }
}

// The STM32/nRF52 boot: the app env's firmware.elf on the profile's Renode platform, two virtual seconds (setup() and
// the first reading), the console UART read back. Same success test as QEMU: the boot banner's revision.
export async function bootRenode(root: string, fwDir: string, profile: McuProfile, timeoutMs: number): Promise<BootResult> {
	const elf = join(fwDir, ".pio/build", envFor(profile, "app"), "firmware.elf")
	if (!existsSync(elf)) return { booted: false, serial: `missing build output: ${elf}`, revision: null, backend: "renode" }
	const log = await runRenode(root, renodeScript([{ name: "board", profile, elf }], { runForS: 2 }), fwDir, timeoutMs)
	if (log === null) return { booted: false, serial: "renode not found in tools/renode (npm run setup)", revision: null, backend: "renode" }
	const serial = consoleLines(log, profile.sim.consoleUart!).join("\n")
	const m = serial.match(/bringup rev (\d+)/)
	return { booted: m !== null, serial: serial || log.slice(-4000), revision: m ? Number(m[1]) : null, backend: "renode" }
}
