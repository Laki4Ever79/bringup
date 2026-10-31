import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { detectEnvironment } from "../src/tools/env.ts"
import { run } from "../src/tools/exec.ts"
import { tempDir } from "./helpers.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const env = await detectEnvironment(root)
const ready = env.tsci && env.kicad && env.python && env.pio && env.qemu

test("a mock run boots its firmware in QEMU and the report says which revision printed", { skip: !ready && "a hardware tool or QEMU is missing", timeout: 900_000 }, async () => {
	const out = tempDir()
	const r = await run(join(root, "node_modules/.bin/tsx"), ["src/main.ts", "briefs/logger.md", "--mock", "--out", out], { cwd: root, timeoutMs: 880_000 })
	assert.equal(r.code, 0, `exit ${r.code}\n${r.stdout.slice(-3000)}\n${r.stderr.slice(-3000)}`)
	const trace = readFileSync(join(out, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
	const firmware = trace.filter((e) => e.type === "artifact.ready" && e.payload.kind === "firmware").at(-1)
	const boot = trace.filter((e) => e.type === "firmware.booted").at(-1)
	assert.ok(boot, "no firmware.booted event")
	assert.equal(boot.payload.booted, true, boot.payload.serialTail)
	assert.equal(boot.payload.revision, firmware.payload.revision, "the newest firmware was booted")
	assert.equal(boot.payload.bootRevision, firmware.payload.revision, "the firmware printed the contract revision it was built from")
	assert.match(readFileSync(join(out, "report.md"), "utf8"), new RegExp(`^- Firmware boot \\(QEMU\\): booted, printed revision ${firmware.payload.revision}; SENSOR FAIL is expected: QEMU emulates no I2C sensor$`, "m"))
})
