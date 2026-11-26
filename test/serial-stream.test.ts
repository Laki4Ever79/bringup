// Streaming a robot's serial lines into the design (src/bench/serial-stream.ts), proven before real hardware: a
// pseudo-terminal (Python's pty, standing in for the USB port) is fed a recorded simulated drive's uart0.txt; every
// line lands in bench/session-*.jsonl, and the saved session diagnoses exactly as the log does.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { sessionText, streamSerial } from "../src/bench/serial-stream.ts"
import { diagnoseRoverLog, parseRoverLog } from "../src/bench/rover-log.ts"
import { tempDir } from "./helpers.ts"

const ROOT = resolve(import.meta.dirname, "..")
const REC = join(ROOT, "out", "20261120-235130", "drive", "rev-12", "uart0.txt")
const hasPty = spawnSync("python3", ["-c", "import pty"]).status === 0

// A pseudo-terminal pair: python prints the follower's path, waits for "go" on stdin, writes the log to the leader a
// line at a time, then closes it (the reader then sees the end of the session).
const FEEDER = `import os, pty, sys, time
m, s = pty.openpty()
print(os.ttyname(s), flush=True)
sys.stdin.readline()
for line in open(sys.argv[1], "rb").read().splitlines(keepends=True):
    os.write(m, line.replace(b"\\n", b"\\r\\n"))
    time.sleep(0.002)
time.sleep(0.3)
os.close(m)
`

test("a robot's serial lines stream into the design, through a pseudo-terminal fed a recorded drive log", { skip: !hasPty || !existsSync(REC) ? "needs python3's pty and the recorded rover run" : false, timeout: 30_000 }, async () => {
	const dir = tempDir()
	const feeder = join(dir, "feed.py")
	writeFileSync(feeder, FEEDER)
	const py = spawn("python3", [feeder, REC], { stdio: ["pipe", "pipe", "inherit"] })
	const tty = await new Promise<string>((res) => py.stdout.once("data", (d) => res(String(d).trim())))
	const seen: string[] = []
	const s = streamSerial(tty, dir, { onLine: (l) => seen.push(l) })
	py.stdin.write("go\n")
	await Promise.race([s.done, new Promise((r) => py.on("exit", () => setTimeout(r, 300)))])
	s.close()
	const want = readFileSync(REC, "utf8").split(/\r?\n/).filter((l) => l.trim())
	assert.deepEqual(seen, want, "every line, in order, without the CR the terminal adds")
	assert.equal(s.lines(), want.length)
	const saved = sessionText(readFileSync(s.file, "utf8"))
	assert.match(s.file, /bench[\\/]session-.+\.jsonl$/)
	assert.deepEqual(diagnoseRoverLog(parseRoverLog(saved)), diagnoseRoverLog(parseRoverLog(readFileSync(REC, "utf8"))), "the saved session diagnoses as the log does")
})
