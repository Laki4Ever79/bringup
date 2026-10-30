import { test } from "node:test"
import assert from "node:assert/strict"
import { wiringSection } from "../src/agents/reviewer.ts"
import { generatedNets } from "../src/codegen/circuit.ts"
import type { BoardArtifact } from "../src/contract/consistency.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { fixtureContract } from "./fixture.ts"

function logger() {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	return s
}

const board = (nets: Record<string, string[]>, extra: Partial<BoardArtifact> = {}): BoardArtifact => ({ revision: 9, dir: "/b", pcbPath: "/b/b.kicad_pcb", stepPath: null, renderPath: null, widthMm: 50, heightMm: 30, nets, ...extra })

test("the wiring section names the generated CC resistors and the D± nets to GPIO18/19", () => {
	const text = wiringSection(logger(), undefined).join("\n")
	assert.match(text, /^## Board-generated wiring \(added by the board generator, not in the contract\)$/m)
	assert.match(text, /R2 5\.1k \(C25905\): USB-C CC1 .*→ GND/)
	assert.match(text, /R3 5\.1k \(C25905\): USB-C CC2 .*→ GND/)
	assert.match(text, /R4 4\.7k \(C25900\): charger PROG/)
	assert.match(text, /R5 10k \(C25744\): I2C_SDA pull-up/)
	assert.match(text, /USB_DP: J1\.pin10 \(D\+\), J1\.pin12 \(D\+\), U1\.GPIO19/)
	assert.match(text, /USB_DN: .*U1\.GPIO18/)
	assert.match(text, /^- VBAT: .*U4\.BAT/m)
	assert.match(text, /^- VBAT: .*U3\.VIN/m)
	assert.match(text, /No board has been built yet/)
})

test("passives the generator adds, not the contract, are marked as added", () => {
	const text = wiringSection(fixtureContract(), undefined).join("\n")
	assert.match(text, /R\d+ 5\.1k \(C25905\): USB-C CC1 .*\[added by the board generator\]/)
})

test("each generated net is confirmed against the built board, or reported missing", () => {
	const s = logger()
	const nets = Object.fromEntries([...generatedNets(s)].map(([n, ends]) => [n, ends]))
	const confirmed = wiringSection(s, board(nets)).join("\n")
	assert.match(confirmed, /checked against the board built for revision 9: every generated net above is on it/)
	const missing = wiringSection(s, board({ ...nets, USB_DP: ["J1.pin10"] })).join("\n")
	assert.match(missing, /USB_DP is missing J1\.pin12, U1\.GPIO19 on the board built for revision 9/)
})

test("a stubbed board is not taken as confirmation", () => {
	const text = wiringSection(logger(), { ...board({}), stub: true } as BoardArtifact).join("\n")
	assert.match(text, /stubbed \(--no-hardware\)/)
})
