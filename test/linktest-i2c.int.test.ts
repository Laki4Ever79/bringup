// An I2C link whose target sends (docs/system.md): both boards' bench link-test builds compile, the target answering
// the controller's read and the controller reading it. QEMU can't join two I2C buses, so compiling is as far as a test
// on this computer goes; the bench plan runs it on real boards. Needs PlatformIO; skipped otherwise.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT } from "../src/run.ts"
import { buildLinkTestFirmware, prepareFirmware } from "../src/tools/firmware.ts"
import { BENCH_ENV } from "../src/system/bench-plan.ts"
import { boardLinks } from "../src/system/derive.ts"
import { LINK_CONNECTOR } from "../src/contract/links.ts"
import { linkProposal, LOGGER_DESIGN } from "../src/inference/scripts.ts"
import type { SystemSpec } from "../src/system/spec.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"
import { fixtureContract } from "./fixture.ts"
import { tempDir } from "./helpers.ts"

const pio = [join(ROOT, ".venv/bin/pio")].find(existsSync) ?? null

const spec: SystemSpec = {
	name: "sensor and hub",
	boards: [{ name: "hub", brief: "h.md" }, { name: "sensor", brief: "s.md" }],
	links: [{ id: "L1", kind: "i2c", a: { board: "hub" }, b: { board: "sensor" }, i2c: { controller: "hub", targets: { sensor: 0x42 }, pullupsOn: "hub" }, cable: { lengthMm: 200 }, messages: [{ name: "reading", from: "sensor", fields: [{ name: "tempCx100", type: "i16" }, { name: "rhx100", type: "u16" }] }] }],
}

// The hub drives its own sensor on the bus it shares with the link; the target board has no local I2C device (its one
// I2C controller is the link's target), so its bus goes straight to the connector.
function board(name: string, sensor: boolean): ContractSnapshot {
	const c = fixtureContract()
	c.values = { ...c.values, ...structuredClone(LOGGER_DESIGN) }
	if (!sensor) {
		c.values.parts = c.values.parts!.filter((p) => !["U2", "R5", "R6"].includes(p.ref))
		c.values.pins = c.values.pins!.filter((p) => p.partRef !== "U2")
	}
	c.values.links = boardLinks(spec, name)
	for (const l of c.values.links) c.values.parts = [...c.values.parts!, { ref: l.connector, role: "connector", ...LINK_CONNECTOR }]
	for (let next = linkProposal(c); next; next = linkProposal(c)) (c.values as Record<string, unknown>)[next.field] = next.value
	return c
}

test("both sides of an I2C link whose target sends compile as link tests", { skip: pio ? false : "needs PlatformIO", timeout: 900_000 }, async () => {
	for (const [name, sensor] of [["hub", true], ["sensor", false]] as const) {
		const dir = tempDir()
		await prepareFirmware(ROOT, dir, board(name, sensor))
		const link = readFileSync(join(dir, "include", "link.h"), "utf8")
		assert.match(link, name === "hub" ? /Wire\.requestFrom/ : /Wire\.onRequest/, `${name}'s link.h`)
		const r = await buildLinkTestFirmware(pio!, dir, BENCH_ENV)
		assert.equal(r.ok, true, `${name}: ${r.log.slice(-3000)}`)
		assert.ok(existsSync(join(dir, ".pio", "build", BENCH_ENV, "firmware.bin")), `${name}: no firmware.bin`)
	}
})
