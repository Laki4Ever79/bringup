// A stand-in for py/bench.py speaking the bridge protocol (docs/design/bench.md §3b), for bench-bridge tests.
import { createInterface } from "node:readline"
const out = (line) => process.stdout.write(JSON.stringify({ at: Date.now(), ...line }) + "\n")
out({ k: "hello", source: process.argv[2] ?? "fake", ports: { dut: null, fixture: null, telemetry: null }, meter: true })
process.stdout.write("not json\n")
process.stderr.write("bridge: started\n")
createInterface({ input: process.stdin }).on("line", (raw) => {
	const c = JSON.parse(raw)
	if (c.cmd === "flash") {
		out({ k: "flashing", id: c.id, stage: "build", pct: 0 })
		out({ k: "flashing", id: c.id, stage: "write", pct: 50 })
		out({ k: "ack", id: c.id, ok: true, ms: 12 })
		out({ k: "boot", rev: 7, reset: "poweron", mode: "live" })
	} else if (c.cmd === "quit") {
		out({ k: "ack", id: c.id, ok: true })
		out({ k: "bye" })
		process.exit(0)
	} else out({ k: "ack", id: c.id, ok: c.cmd !== "recover", ...(c.cmd === "recover" ? { error: "no fixture" } : {}) })
})
