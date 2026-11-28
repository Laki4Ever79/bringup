// Real CNC run 3 (28 Nov 2026): its DC jack (XunPu DC-091-A250) sat in the contract's connectors, and a connector's
// footprint was written as its name; the generator's own land pattern for it is JSX, so tscircuit refused every build
// ('Invalid footprint prop on connector "J2": "dc091a250"') from rev 14 to rev 28.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { circuitFromContract, DC091_FOOTPRINT } from "../src/codegen/circuit.ts"

test("a connector whose land pattern the generator draws is written as that pattern, not its name", () => {
	const s = JSON.parse(readFileSync(new URL("./fixtures/cnc3-real-rev28.json", import.meta.url), "utf8"))
	const jack = s.values.connectors.find((c: { ref: string }) => c.ref === "J2")
	assert.ok(jack, "the run's jack is a connector")
	const line = circuitFromContract(s).split("\n").find((l) => l.includes('<connector name="J2"'))!
	assert.doesNotMatch(line, new RegExp(`footprint="${DC091_FOOTPRINT}"`))
	assert.match(line, /footprint=\{<footprint>.*<platedhole /, "its pads and holes, as the arm's jack gets them")
})
