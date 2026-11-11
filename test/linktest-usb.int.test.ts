// The bench's link-test build (docs/system.md, the system's bench-plan.md): the logger's own firmware, with its link,
// compiles as esp32c3_linktest_usb (USB output, sends until reset). Needs PlatformIO; skipped otherwise.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { ROOT } from "../src/run.ts"
import { buildLinkTestFirmware, prepareFirmware } from "../src/tools/firmware.ts"
import { BENCH_ENV } from "../src/system/bench-plan.ts"
import { boardLinks } from "../src/system/derive.ts"
import { LINK_CONNECTOR } from "../src/contract/links.ts"
import { linkProposal, LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { loadSpec } from "../src/system/spec.ts"
import { fixtureContract } from "./fixture.ts"
import { tempDir } from "./helpers.ts"

const pio = [join(ROOT, ".venv/bin/pio")].find(existsSync) ?? null

test("the logger's bench link-test build compiles with its UART link", { skip: pio ? false : "needs PlatformIO", timeout: 600_000 }, async () => {
	const spec = loadSpec("briefs/systems/logger-beacon-uart.json")
	const c = fixtureContract()
	c.values = { ...c.values, ...structuredClone(LOGGER_DESIGN) }
	c.values.links = boardLinks(spec, "logger")
	for (const l of c.values.links) c.values.parts = [...c.values.parts!, { ref: l.connector, role: "connector", ...LINK_CONNECTOR }]
	for (let next = linkProposal(c); next; next = linkProposal(c)) (c.values as Record<string, unknown>)[next.field] = next.value
	const dir = tempDir()
	await prepareFirmware(ROOT, dir, c)
	const r = await buildLinkTestFirmware(pio!, dir, BENCH_ENV)
	assert.equal(r.ok, true, r.log)
	assert.ok(existsSync(join(dir, ".pio", "build", BENCH_ENV, "firmware.bin")), "built as the bench env, not the QEMU one")
})
