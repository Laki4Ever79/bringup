import { spawn } from "node:child_process"
import { existsSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { McuProfile } from "../mcu/profile.ts"

// Renode (Antmicro, MIT; tools/renode, docs/mcu.md, Simulation): boots an STM32 or nRF52 firmware ELF on the chip's
// platform description and reads the console UART through a logging analyzer. Time inside is virtual: don't read
// timings from it. Several machines on one virtual clock can share a UART hub, which is how two boards' link is tested.

// The Renode launcher under tools/renode (renode_<version>-portable/renode), or null.
export function renodePath(root: string): string | null {
	const dir = join(root, "tools/renode")
	if (!existsSync(dir)) return null
	const sub = readdirSync(dir).filter((d) => d.startsWith("renode_")).sort().at(-1)
	const bin = sub ? join(dir, sub, "renode") : null
	return bin && existsSync(bin) ? bin : null
}

export interface RenodeMachine {
	name: string
	profile: McuProfile
	elf: string
}

// The .resc script for one or more machines; with link set, each machine's link UART joins one hub (a cable).
export function renodeScript(machines: RenodeMachine[], opts: { runForS: number; link?: { uart: string } }): string {
	const lines: string[] = []
	if (opts.link) lines.push(`emulation CreateUARTHub "link"`)
	for (const m of machines) {
		if (!m.profile.sim.machine || !m.profile.sim.consoleUart) throw new Error(`${m.profile.mpn}: no Renode platform in its profile`)
		lines.push(
			`mach create ${JSON.stringify(m.name)}`,
			`machine LoadPlatformDescription @${m.profile.sim.machine}`,
			`sysbus LoadELF @${m.elf}`,
			`showAnalyzer sysbus.${m.profile.sim.consoleUart} Antmicro.Renode.Analyzers.LoggingUartAnalyzer`,
		)
		if (opts.link) lines.push(`connector Connect sysbus.${opts.link.uart} link`)
	}
	lines.push(`emulation RunFor "${opts.runForS}"`, "quit")
	return lines.join("\n") + "\n"
}

// What each machine printed on its console, from Renode's log: "[INFO] <uart>: [host: …|virt: …] <text>" lines, the
// machine named in the log when there are several ("<machine>/<uart>").
export function consoleLines(log: string, uart: string, machine?: string): string[] {
	const out: string[] = []
	const clean = log.replace(/\x1b\[[0-9;]*m/g, "")
	for (const line of clean.split("\n")) {
		const m = /\[INFO\] (?:([\w-]+)\/)?(\w+): \[host:[^\]]*\] ?(.*)$/.exec(line)
		if (!m || m[2] !== uart) continue
		if (machine && m[1] && m[1] !== machine) continue
		out.push(m[3])
	}
	return out
}

// Runs a script in Renode headless until it quits or the host timeout passes; returns the whole log.
export function runRenode(root: string, script: string, workDir: string, timeoutMs: number): Promise<string | null> {
	const bin = renodePath(root)
	if (!bin) return Promise.resolve(null)
	const resc = join(workDir, "bringup.resc")
	writeFileSync(resc, script)
	return new Promise((resolve) => {
		let out = ""
		const child = spawn(bin, ["--disable-gui", "--console", "--plain", "-e", `include @${resc}`], { stdio: ["ignore", "pipe", "pipe"] })
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
		const add = (d: Buffer) => { out = (out + d).slice(-200_000) }
		child.stdout.on("data", add)
		child.stderr.on("data", add)
		child.on("error", (e) => { clearTimeout(timer); resolve(`${out}\n${e.message}`) })
		child.on("close", () => { clearTimeout(timer); resolve(out) })
	})
}
