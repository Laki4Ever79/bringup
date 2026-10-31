import { test } from "node:test"
import assert from "node:assert/strict"
import { cpSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ROOT } from "../src/run.ts"
import { runDrc } from "../src/tools/drc.ts"
import { detectEnvironment } from "../src/tools/env.ts"

const env = await detectEnvironment(ROOT)
// A logger board as built (rev 8 of a demo run): its J1 (TYPE-C-31-M-12) has GND pads 0.171 mm from its own NPTH holes.
const FIXTURE = join(ROOT, "test/data/drc-j1")
const copy = () => {
	const dir = mkdtempSync(join(tmpdir(), "bringup-drc-"))
	cpSync(FIXTURE, dir, { recursive: true })
	return dir
}

test("KiCad: with the USB-C vendor rule the logger board is DRC-clean; without it, J1's two pad ↔ hole errors are back", { skip: !env.kicad && "the kicad docker image is missing", timeout: 400_000 }, async () => {
	const ruled = await runDrc(env, copy(), "board.kicad_pcb", "board.kicad_pro", ["J1"])
	assert.equal(ruled?.errors, 0, JSON.stringify(ruled?.byType))
	assert.equal(ruled?.unconnected, 0)
	assert.deepEqual(ruled?.exemptions, ["USB-C vendor land pattern (J1): pad ↔ its own locating hole ≥ 0.15 mm"])
	const plain = await runDrc(env, copy(), "board.kicad_pcb", "board.kicad_pro", [])
	assert.equal(plain?.errors, 2)
	assert.deepEqual(plain?.ownFootprint, { J1: 2 })
	assert.deepEqual(plain?.exemptions, [])
	// Scoped to another part, the rule doesn't reach J1: the fab's 0.2 mm still applies there.
	const elsewhere = await runDrc(env, copy(), "board.kicad_pcb", "board.kicad_pro", ["U1"])
	assert.equal(elsewhere?.errors, 2)
})
