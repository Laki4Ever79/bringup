// npm run setup [-- --qemu] [-- --wokwi]   install the toolchain (idempotent)
// npm run doctor                           show what this machine has
import "dotenv/config"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { detectEnvironment } from "../tools/env.ts"
import { run } from "../tools/exec.ts"
import { doctorReport } from "./doctor.ts"
import { presentOn, runSetup, type Probe } from "./setup.ts"

const root = fileURLToPath(new URL("../..", import.meta.url))
const [command, ...flags] = process.argv.slice(2)

if (command === "doctor") {
	console.log(doctorReport(await detectEnvironment(root), process.env))
} else if (command === "setup") {
	const check: Probe["check"] = async (cmd, args) => {
		const r = await run(cmd, args, { cwd: root, timeoutMs: 30_000 })
		return { code: r.code, out: r.stdout + r.stderr }
	}
	const probe: Probe = {
		nodeVersion: process.versions.node,
		check,
		present: presentOn(root, check),
		install: (cmd, args) =>
			new Promise((done) => {
				const child = spawn(cmd, args, { cwd: root, stdio: "inherit" })
				child.on("error", () => done(-1))
				child.on("exit", (code) => done(code ?? -1))
			}),
		log: (line) => console.log(line),
	}
	const summary = await runSetup(probe, { qemu: flags.includes("--qemu"), wokwi: flags.includes("--wokwi") })
	console.log(`\nsetup summary:\n${summary.lines.map((l) => `  ${l}`).join("\n")}`)
	if (summary.ok) console.log("\nnext: npm run doctor, then npm run bringup -- briefs/beacon.md --mock")
	process.exit(summary.ok ? 0 : 1)
} else {
	console.error("usage: tsx src/setup/cli.ts setup [--qemu] [--wokwi] | doctor")
	process.exit(2)
}
