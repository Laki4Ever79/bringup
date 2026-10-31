import assert from "node:assert/strict"
import { appendFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { writeReport } from "../src/report.ts"
import { BringupState } from "../src/runtime.ts"
import type { Env } from "../src/tools/env.ts"
import { tempDir } from "./helpers.ts"

const env: Env = { root: ".", tsci: "tsci", kicad: "docker", python: "python", pio: "pio", qemu: "qemu" }

function report(opts: { booted?: object[]; env?: Env; noHardware?: boolean } = {}): string {
	const s = new BringupState(tempDir())
	for (const payload of opts.booted ?? []) {
		appendFileSync(join(s.outDir, "trace.jsonl"), JSON.stringify({ seq: 0, at: new Date().toISOString(), type: "firmware.booted", producerId: "x", payload }) + "\n")
	}
	return readFileSync(writeReport(s.outDir, s, opts.env ?? env, true, { noHardware: opts.noHardware }), "utf8")
}

test("report: the last boot printed the firmware's revision", () => {
	const text = report({ booted: [{ revision: 5, booted: false, bootRevision: null, serialTail: "" }, { revision: 7, booted: true, bootRevision: 7, serialTail: "bringup rev 7" }] })
	assert.match(text, /^- Firmware boot \(QEMU\): booted, printed revision 7$/m)
})

test("report: a boot that failed shows its last serial line", () => {
	const text = report({ booted: [{ revision: 7, booted: false, bootRevision: null, serialTail: "ESP-ROM\nassert failed: init_flash" }] })
	assert.match(text, /^- Firmware boot \(QEMU\): did NOT boot \(firmware rev 7\): assert failed: init_flash$/m)
})

test("report: QEMU missing, --no-hardware, or nothing built", () => {
	assert.match(report({ env: { ...env, qemu: null } }), /^- Firmware boot \(QEMU\): not run \(QEMU not installed; see NOTES\.md\)$/m)
	assert.match(report({ noHardware: true }), /^- Firmware boot \(QEMU\): not run \(--no-hardware\)$/m)
	assert.match(report(), /^- Firmware boot \(QEMU\): not run \(no firmware compiled\)$/m)
})

// Real run 15: every QEMU boot printed SENSOR FAIL. QEMU has no I2C sensor, so that is expected, not a driver bug.
test("a boot that printed SENSOR FAIL says it is expected in QEMU", () => {
	const text = report({ booted: [{ revision: 41, booted: true, bootRevision: 41, serialTail: "bringup rev 41\nSENSOR FAIL" }] })
	assert.match(text, /^- Firmware boot \(QEMU\): booted, printed revision 41; SENSOR FAIL is expected: QEMU emulates no I2C sensor$/m)
})
