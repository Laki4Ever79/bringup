// A missing CNC firmware signal is asked for with its whole pin entry (src/cnc/signal-ends.ts, docs/cnc.md gap 2): each
// scripted pin taken out in turn, the check names the scripted design's own partRef and partPin; with no TX resistor,
// it names the part to add.
import { test } from "node:test"
import assert from "node:assert/strict"
import { CNC_DESIGN, CNC_FLUIDNC_DESIGN, CNC_MACHINE } from "../src/inference/scripts.ts"
import { cncChecks } from "../src/cnc/checks.ts"
import { defaultCheckCatalog } from "../src/mechanics/checks.ts"
import type { ContractValues } from "../src/contract/types.ts"

const cat = defaultCheckCatalog()!
const values = (over: Partial<ContractValues>, firmware: "grblhal" | "fluidnc" = "grblhal") => ({ ...(firmware === "fluidnc" ? CNC_FLUIDNC_DESIGN : CNC_DESIGN), cnc: { ...CNC_MACHINE, firmware }, ...over }) as ContractValues
const wiring = (v: ContractValues) => cncChecks(v, cat).filter((x) => x.kind === "cnc-wiring").map((x) => x.message)

test("each signal the firmware needs, left out, is asked for on the part and pin the scripted design puts it", () => {
	// The whole message, every signal missing at once, names every end (the gantry's Y2 on the third driver, U6).
	const all = wiring(values({ pins: CNC_DESIGN.pins!.filter((p) => p.signal === "STATUS_LED") })).find((x) => x.startsWith("grblHAL"))!
	assert.match(all, /Y2_STEP \(partRef U6, partPin STEP\)/)
	assert.match(all, /STEPPERS_EN \(partRef U9, partPin B\)/)
	const listed = all.slice(all.indexOf(" for ") + 5, all.indexOf(": assign")).split("), ")
	assert.equal(listed.length, 16)
	assert.ok(listed.every((x) => /^[A-Z0-9_]+ \(partRef \w+, partPin \w+\)?$/.test(x)), listed.join(" | "))
	assert.deepEqual(wiring(values({})), [])
	for (const p of CNC_DESIGN.pins!.filter((x) => x.signal !== "STATUS_LED" && x.signal !== "SPINDLE_I")) {
		const m = wiring(values({ pins: CNC_DESIGN.pins!.filter((q) => q !== p) }))
		assert.ok(m.some((x) => x.includes(`${p.signal} (partRef ${p.partRef}, partPin ${p.partPin})`)), `${p.signal}: ${m.join(" | ")}`)
	}
})

test("no TX resistor: the check names the 1 kΩ to add and where its pin2 goes, for FluidNC too", () => {
	const v = values({ parts: CNC_FLUIDNC_DESIGN.parts!.filter((p) => p.ref !== "R20"), pins: CNC_FLUIDNC_DESIGN.pins!.filter((p) => p.partRef !== "R20") }, "fluidnc")
	const m = wiring(v).find((x) => x.includes("STEPPER_UART_TX"))
	assert.ok(m)
	assert.match(m, /FluidNC's config\.yaml needs a GPIO for STEPPER_UART_TX \(a 1 kΩ resistor \(0402WGF1001TCE, LCSC C11702, 0402, pins \["pin1", "pin2"\], nets \{ "pin2": "@STEPPER_UART" \}\)/)
})
