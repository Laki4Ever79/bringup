// Two STM32 boards' link-test firmwares joined by a virtual cable in Renode (docs/mcu.md, Simulation): the same link
// test the ESP32-C3 pair runs in QEMU, on another vendor's chip and simulator.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { ROOT } from "../src/run.ts"
import { runSystem } from "../src/system/run.ts"
import { loadSpec } from "../src/system/spec.ts"
import { renodePath } from "../src/tools/renode.ts"
import { tempDir } from "./helpers.ts"

const pio = [join(ROOT, ".venv/bin/pio")].find(existsSync) ?? null
const renode = Boolean(renodePath(ROOT))
const skip = pio && renode ? false : "needs PlatformIO and Renode"

test("two STM32G031 boards talk over their UART link in Renode, with the reading intact", { skip, timeout: 1_200_000 }, async () => {
	const out = tempDir()
	const r = await runSystem({ spec: loadSpec("briefs/systems/stm32-pair-uart.json"), outDir: out, mock: true, boardArgs: ["--no-hardware", "--no-review"], pollMs: 500, timeoutMs: 240_000, linkTest: { root: ROOT, pio, qemu: false, renode } })
	assert.deepEqual(r.linkTests.map((t) => [t.link, t.ran, t.passed]), [["L1", true, true]], JSON.stringify(r.linkTests))
	assert.match(r.linkTests[0].detail, /booted in Renode/)
	assert.equal(r.ok, true)
})
