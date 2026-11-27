// QEMU probe (.github/workflows/qemu-probe.yml, on demand): the scripted rover's simulation firmware built once, then
// booted in Espressif's QEMU under each icount setting for a fixed wall time, each console's first lines printed. Why:
// on GitHub's Windows runner the drive's firmware never answered: with icount 3 it stopped after "entry 0x403cbf10";
// with shift=3,sleep=off it panicked ("Stack protection fault ... ASSIST_DEBUG is not triggered BUT interrupt
// occurred!") in a loop, while Linux and macOS boot it at once. One run compares the settings side by side.
// usage: npx tsx scripts/qemu-probe.ts [seconds per variant, default 40]
import { spawn } from "node:child_process"
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import { mergeFlash } from "../src/tools/emulator.ts"
import { detectEnvironment, qemuEnv } from "../src/tools/env.ts"
import { prepareFirmware } from "../src/tools/firmware.ts"
import { run } from "../src/tools/exec.ts"
import { qemuBinary, qemuTarget } from "../src/tools/qemu.ts"

const root = process.cwd()
const secs = Number(process.argv[2] ?? 40)
const say = (m: string) => {
	console.log(m)
	if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, m + "\n")
}
const env = await detectEnvironment(root)
const target = qemuTarget("esp32c3")!
const qemu = qemuBinary(root, target)
if (!env.pio || !qemu) throw new Error(`needs PlatformIO and QEMU (setup firmware sim): pio ${env.pio}, qemu ${qemu}`)
const fw = join(mkdtempSync(join(tmpdir(), "qemu-probe-")), "fw")
const s: ContractSnapshot = { revision: 1, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) }
await prepareFirmware(root, fw, s)
const t0 = Date.now()
// Two images: the firmware as it is, and with its stack guard's interrupt masked (SIM_NO_STACK_GUARD_IRQ, hw_sim.cpp).
const images: Record<string, string> = {}
for (const [name, flags] of [["plain", ""], ["stack-guard IRQ masked", "-DSIM_NO_STACK_GUARD_IRQ"]] as const) {
	const build = await run(env.pio, ["run", "-d", fw, "-e", target.simEnv], { timeoutMs: 1_800_000, env: { ...(process.env as Record<string, string>), PLATFORMIO_BUILD_FLAGS: flags } })
	if (build.code !== 0) throw new Error(`the simulation firmware (${name}) didn't build: ${(build.stdout + build.stderr).slice(-1500)}`)
	const { image, log } = await mergeFlash(fw, target.simEnv, target.chip)
	if (!image) throw new Error(`no flash image: ${log}`)
	images[name] = join(fw, `flash-${name.replace(/\W+/g, "_")}.bin`)
	copyFileSync(image, images[name])
}
say(`### ${process.platform}: QEMU probe (both firmwares built in ${Math.round((Date.now() - t0) / 1000)} s)\n`)

const VARIANTS: [string, string[]][] = [
	["icount 3 (sleep on)", ["-icount", "3"]],
	["icount shift=3,sleep=off", ["-icount", "shift=3,sleep=off"]],
	["icount shift=auto", ["-icount", "shift=auto"]],
	["no icount", []],
]
for (const [fwName, image] of Object.entries(images))
for (const [icountName, icount] of VARIANTS) {
	const name = `${fwName}, ${icountName}`
	const uart0 = join(fw, `uart0-${name.replace(/\W+/g, "_")}.txt`)
	const args = ["-display", "none", "-machine", target.machine, ...icount, "-drive", `file=${image},if=mtd,format=raw`, "-global", `driver=timer.${target.machine}.timg,property=wdt_disable,value=true`, "-serial", `file:${uart0}`, "-serial", "null"]
	const q = spawn(qemu, args, { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, ...qemuEnv(root) } })
	let err = ""
	let exit: string | null = null
	q.stderr.on("data", (d) => (err += d))
	q.on("exit", (c, sig) => (exit = `exited ${c ?? sig}`))
	await new Promise((r) => setTimeout(r, secs * 1000))
	q.kill()
	const text = existsSync(uart0) ? readFileSync(uart0, "latin1") : ""
	const verdict = /ROVER ready/.test(text) ? "BOOTS (ROVER ready)" : /Guru Meditation/.test(text) ? `PANICS (${(/Guru Meditation Error: [^\r\n]*/.exec(text) ?? [""])[0].slice(0, 90)})` : /entry 0x/.test(text) ? "stops after the bootloader" : "no console"
	say(`- **${name}**: ${verdict}; ${text.length} bytes in ${secs} s${exit ? `; QEMU ${exit}: ${err.trim().split("\n").pop()}` : ""}`)
	console.log(`--- ${name}: first lines ---\n${text.split(/\r?\n/).slice(0, 25).join("\n")}\n---`)
}
process.exit(0)
