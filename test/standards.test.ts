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

test("a UART link with messages lists our own frame and its open alternative", () => {
	const spec: SystemSpec = { name: "x", boards: [{ name: "a", brief: "a.md" }, { name: "b", brief: "b.md" }], links: [{ id: "L1", kind: "uart", a: { board: "a" }, b: { board: "b" }, cable: { lengthMm: 200 }, messages: [{ name: "reading", from: "a", fields: [{ name: "t", type: "i16" }] }] }] }
	const s = logger()
	s.values.links = boardLinks(spec, "a")
	const rows = interfacesOf(s)
	assert.equal(rows.find((r) => r.interface.startsWith("UART link"))?.openness, "open")
	const frame = rows.find((r) => r.interface.startsWith("messages over UART"))!
	assert.equal(frame.openness, "ours")
	assert.match(frame.alternative!, /COBS .* CBOR/)
	assert.equal(rows.find((r) => r.interface.startsWith("link connector"))?.openness, "vendor")
	const section = standardsSection(s).join("\n")
	assert.match(section, /^## Interfaces and standards/)
	assert.match(section, /\| messages over UART\/I²C links .* \| Bringup's own \|/)
	assert.match(section, /Not open, and the open alternative:\n- /)
})
