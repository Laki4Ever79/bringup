import assert from "node:assert/strict"
import { test } from "node:test"
import { interfacesOf, standardsSection } from "../src/contract/standards.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { boardLinks } from "../src/system/derive.ts"
import type { SystemSpec } from "../src/system/spec.ts"
import { fixtureContract } from "./fixture.ts"

const logger = () => {
	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	return s
}

test("every interface of the logger, with its standard and whether it is open", () => {
	const s = logger()
	s.values.connectivity = { radio: "ble", report: ["gatt", "bthome"], updates: "none" } as never
	const rows = interfacesOf(s)
	const by = (needle: string) => rows.find((r) => r.interface.includes(needle))
	assert.equal(by("USB-C")?.openness, "open")
	assert.equal(by("BLE advertising")?.openness, "open")
	assert.equal(by("phone reads history")?.openness, "ours")
	assert.match(by("phone reads history")!.alternative!, /Environmental Sensing Service/)
	assert.equal(by("design files")?.openness, "open")
	assert.equal(by("SBOM")?.openness, "open")
	// No links: no link rows.
	assert.ok(!rows.some((r) => /link/.test(r.interface)))
	// Every row that isn't open names its open alternative.
	assert.ok(rows.filter((r) => r.openness !== "open").every((r) => r.alternative))
})

test("a UART link with messages lists its open frame: COBS and CRC-16 around a CBOR payload", () => {
	const spec: SystemSpec = { name: "x", boards: [{ name: "a", brief: "a.md" }, { name: "b", brief: "b.md" }], links: [{ id: "L1", kind: "uart", a: { board: "a" }, b: { board: "b" }, cable: { lengthMm: 200 }, messages: [{ name: "reading", from: "a", fields: [{ name: "t", type: "i16" }] }] }] }
	const s = logger()
	s.values.links = boardLinks(spec, "a")
	const rows = interfacesOf(s)
	assert.equal(rows.find((r) => r.interface.startsWith("UART link"))?.openness, "open")
	const frame = rows.find((r) => r.interface.startsWith("messages over UART"))!
	assert.equal(frame.openness, "open")
	assert.match(frame.standard, /COBS framing .* CRC-16\/CCITT around a CBOR payload \(RFC 8949/)
	assert.equal(frame.alternative, undefined)
	assert.equal(rows.find((r) => r.interface.startsWith("link connector"))?.openness, "vendor")
	const section = standardsSection(s).join("\n")
	assert.match(section, /^## Interfaces and standards/)
	assert.match(section, /\| messages over UART\/I²C links .* \| open \|/)
	// The JST connector is still one vendor's: it is listed with its open alternative.
	assert.match(section, /Not open, and the open alternative:\n- link connector/)
})

// Open standards by default, step 2 (16 Nov 2026): the agents get the rule and each non-open interface with its open
// alternative in their design facts, so they pick the open option where it fits.
test("the agents' design facts carry the open-standards rule and each non-open interface's alternative", async () => {
	const { designFacts } = await import("../src/agents/design-facts.ts")
	const s = logger()
	s.values.connectivity = { radio: "ble", report: ["gatt"], updates: "none" } as never
	const facts = designFacts(s, "").join("\n")
	assert.match(facts, /## Interfaces and standards \(open standards by default\)/)
	assert.match(facts, /Rule: where an open standard fits the job .* choose it over a vendor's or a home-made one/)
	assert.match(facts, /phone reads history over BLE: Bringup's own .* Open alternative: .*Environmental Sensing Service/)
	// Open interfaces get no line of their own.
	assert.doesNotMatch(facts, /USB-C port \(power, flashing, serial\):/)
})
