// Real CNC run 2's lessons (out/real-runs/cc-cnc-2, 27 Nov 2026): the revision budget and the drain follow the design's
// kind; grblHAL on a non-STM32F4 MCU is one clear finding (not a failed simulation sent to the mechanics engineer).
import { test } from "node:test"
import assert from "node:assert/strict"
import { briefKind, designKind, isMachine } from "../src/contract/design-kind.ts"
import { DRAIN_MS } from "../src/agents/consistency.ts"
import { CNC_DESIGN, CNC_FLUIDNC_DESIGN, CNC_MACHINE, CNC_TARGETS } from "../src/inference/scripts.ts"
import { cncChecks } from "../src/cnc/checks.ts"
import { grblhalMcuProblem } from "../src/cnc/grblhal.ts"
import { defaultCheckCatalog } from "../src/mechanics/checks.ts"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { ContractValues } from "../src/contract/types.ts"

test("the kind from the contract and from the brief: every machine kind is a machine", () => {
	assert.equal(designKind({ cncTargets: CNC_TARGETS }), "cnc")
	assert.equal(designKind({ armTargets: {} as never }), "arm")
	assert.equal(designKind({ motion: {} as never }), "rover")
	assert.equal(designKind({}), "board")
	assert.deepEqual((["cnc", "arm", "rover", "board"] as const).map(isMachine), [true, true, true, false])
	const brief = (b: string) => briefKind(readFileSync(resolve(import.meta.dirname, "..", "briefs", `${b}.md`), "utf8"))
	assert.deepEqual(["cnc", "cnc-fluidnc", "rover", "arm"].map(brief), ["cnc", "cnc", "rover", "arm"])
	assert.ok(DRAIN_MS >= 25 * 60_000, "the drain outlasts the CNC's 25-min board build")
})

test("grblHAL on the ESP32: one finding to the mechanics engineer and the architect, no missing-signal list", () => {
	const v = { ...CNC_FLUIDNC_DESIGN, cncTargets: CNC_TARGETS, cnc: { ...CNC_MACHINE, firmware: "grblhal" } } as ContractValues
	const m = cncChecks(v, defaultCheckCatalog()!).filter((x) => x.kind === "cnc-wiring")
	const mcu = m.filter((x) => /builds grblHAL for the STM32F4/.test(x.message))
	assert.equal(mcu.length, 1)
	assert.deepEqual(mcu[0].affects, ["mechanics", "architect"])
	assert.match(mcu[0].message, /this board's MCU is the ESP32-WROOM-32E: set cnc.firmware to "fluidnc"/)
	assert.equal(m.filter((x) => /grblHAL's board map needs/.test(x.message)).length, 0)
	assert.equal(grblhalMcuProblem(CNC_DESIGN.parts!), null)
})

test("the power tree's 5 V joins the contract's one 5 V rail (V5V), not a separate V5; two 5 V rails: no merge", async () => {
	const { generatedNets, codeSupplyRail } = await import("../src/codegen/circuit.ts")
	const { completePowerTree } = await import("../src/contract/power-auto.ts")
	const { fixtureContract } = await import("./fixture.ts")
	const b = fixtureContract()
	const values = { ...b.values, ...CNC_DESIGN, cncTargets: CNC_TARGETS, cnc: CNC_MACHINE, rails: [...CNC_DESIGN.rails!, { name: "5V", voltageV: 5, regulatorMaxMa: 1000, loadMa: 50 }] } as ContractValues
	const s0 = { ...b, values } as never as Parameters<typeof generatedNets>[0]
	const s = { ...b, values: { ...values, parts: completePowerTree(values.parts!, undefined, s0).parts } } as never as Parameters<typeof generatedNets>[0]
	const nets = generatedNets(s)
	assert.equal(nets.has("V5"), false)
	assert.ok((nets.get("V5V") ?? []).some((e) => e.startsWith("U8.")), "the spindle buffer's VCC on the rail")
	assert.equal(codeSupplyRail(s, "V5"), "V5V")
	const two = { ...s, values: { ...s.values, rails: [...s.values.rails!, { name: "5V_AUX", voltageV: 5, regulatorMaxMa: 3000, loadMa: 1000 }] } }
	assert.equal(codeSupplyRail(two, "V5"), null)
	// A rail another source drives is never joined: USB's VBUS at 5 V stays apart from the buck's output.
	const usb = { ...s, values: { ...s.values, rails: [...CNC_DESIGN.rails!, { name: "VBUS", voltageV: 5, regulatorMaxMa: 500, loadMa: 100 }] } }
	assert.equal(codeSupplyRail(usb, "V5"), null)
	assert.equal(codeSupplyRail({ ...usb, values: { ...usb.values, rails: [...usb.values.rails!, { name: "5V", voltageV: 5, regulatorMaxMa: 1000, loadMa: 50 }] } }, "V5"), "V5V")
	// No 5 V rail in the contract: the buck keeps its own V5.
	assert.ok(generatedNets({ ...s, values: { ...s.values, rails: CNC_DESIGN.rails } }).has("V5"))
})
