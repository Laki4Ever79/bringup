// The system's link test end to end (docs/system.md, phase 2): a scripted two-board UART system settles, then both
// boards' link-test firmware boots in QEMU joined by a virtual cable, and the logger's reading arrives at the beacon.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT } from "../src/run.ts"
import { runSystem } from "../src/system/run.ts"
import { loadSpec } from "../src/system/spec.ts"
import { tempDir } from "./helpers.ts"

const pio = [join(ROOT, ".venv/bin/pio")].find(existsSync) ?? null
const qemu = existsSync(join(ROOT, "tools/qemu/bin/qemu-system-riscv32"))
const skip = pio && qemu ? false : "needs PlatformIO and QEMU"

test("two boards' firmwares talk over their UART link in QEMU, with the reading intact", { skip, timeout: 1_200_000 }, async () => {
	const out = tempDir()
	const r = await runSystem({ spec: loadSpec("briefs/systems/logger-beacon-uart.json"), outDir: out, mock: true, boardArgs: ["--no-hardware", "--no-review"], pollMs: 500, timeoutMs: 240_000, linkTest: { root: ROOT, pio, qemu } })
	assert.deepEqual(r.linkTests.map((t) => [t.link, t.ran, t.passed]), [["L1", true, true]], JSON.stringify(r.linkTests))
	assert.equal(r.ok, true)
	assert.match(readFileSync(join(out, "linktest", "L1", "uart0-b.txt"), "latin1"), /LINK L1 reading from logger: tempCx100=2150 rhx100=4025/)
	assert.match(readFileSync(r.reportPath, "utf8"), /\| L1 \| pass \|/)
})
