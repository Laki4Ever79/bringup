// `bringup bench-stream <run> <device> [--baud N]` and `bringup bench-log <run> <log>`: the bench companion's free
// commands (rover-log.ts, serial-stream.ts), shared by the repo's CLI (src/main.ts) and `npx bringup-mcp` (bin/).
// bench-stream shows the robot's serial lines as they come and saves them in the design (bench/session-*.jsonl, which
// Bringup Studio's live view reads); Ctrl-C ends the session and prints what it shows. bench-log reads a saved log the
// same way, beside the same design's simulated drive. No model, no cost.
import { existsSync } from "node:fs"
import { join } from "node:path"

export async function benchCli(argv: string[]): Promise<number> {
	if (argv[0] === "bench-stream") {
		const [dir, device] = [argv[1], argv[2]]
		if (!dir || !existsSync(dir) || !device) {
			console.error("bringup: usage: bench-stream <run folder> <serial device, e.g. /dev/ttyACM0> [--baud 115200]")
			return 1
		}
		const baudAt = argv.indexOf("--baud")
		const { streamSerial, sessionText } = await import("./serial-stream.ts")
		const { diagnoseRoverLog, findingsText, parseRoverLog } = await import("./rover-log.ts")
		const { readFileSync } = await import("node:fs")
		const s = streamSerial(device, dir, { baud: baudAt > 0 ? Number(argv[baudAt + 1]) : undefined, onLine: (l) => console.log(l) })
		console.error(`bringup: streaming ${device} into ${s.file} (Ctrl-C to end)`)
		process.once("SIGINT", () => s.close())
		await s.done.catch((e) => console.error(`bringup: ${e instanceof Error ? e.message : e}`))
		console.log(`\n${s.lines()} lines saved.\n\n${findingsText(diagnoseRoverLog(parseRoverLog(existsSync(s.file) ? sessionText(readFileSync(s.file, "utf8")) : "")))}`)
		return 0
	}
	if (argv[0] === "bench-log") {
		const [dir, logFile] = [argv[1], argv[2]]
		if (!dir || !existsSync(dir) || !logFile || !existsSync(logFile)) {
			console.error("bringup: usage: bench-log <run folder> <serial log file>")
			return 1
		}
		const { diagnoseRoverLog, findingsText, parseRoverLog } = await import("./rover-log.ts")
		const { readdirSync, readFileSync } = await import("node:fs")
		const revs = existsSync(join(dir, "drive")) ? readdirSync(join(dir, "drive")).flatMap((n) => { const m = /^rev-(\d+)$/.exec(n); return m ? [Number(m[1])] : [] }).sort((a, b) => b - a) : []
		const simFile = revs.map((r) => join(dir, "drive", `rev-${r}`, "uart0.txt")).find((f) => existsSync(f)) ?? null
		const findings = diagnoseRoverLog(parseRoverLog(readFileSync(logFile, "utf8")), simFile ? parseRoverLog(readFileSync(simFile, "utf8")) : null)
		console.log(`${findingsText(findings)}${simFile ? "" : "\n\n(No simulated drive in this run to compare with.)"}`)
		return findings.length ? 2 : 0
	}
	return 1
}
