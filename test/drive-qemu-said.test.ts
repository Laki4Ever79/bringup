// A drive whose firmware never answered says why: QEMU quit (with its error), or how far the firmware's console got.
import { test } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { qemuSaid } from "../src/tools/drive.ts"
import { tempDir } from "./helpers.ts"

test("qemuSaid: QEMU's exit and last error line, else the console's last line, else that it printed nothing", () => {
	assert.equal(qemuSaid("exited 1", "qemu-system-riscv32.exe: -serial tcp:127.0.0.1:5000: Failed to bind\r\n", null), "QEMU exited 1: qemu-system-riscv32.exe: -serial tcp:127.0.0.1:5000: Failed to bind")
	const uart0 = join(tempDir(), "uart0.txt")
	assert.equal(qemuSaid(null, "", uart0), "QEMU running; the firmware's console printed nothing")
	writeFileSync(uart0, "ESP-ROM:esp32c3-api1-20210207\r\nrover: sim build, waiting for the model\r\n")
	assert.equal(qemuSaid(null, "", uart0), "QEMU running; the firmware's console last printed: rover: sim build, waiting for the model")
})
