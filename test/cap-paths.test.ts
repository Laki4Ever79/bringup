import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { capPaths, circuitFromContract } from "../src/codegen/circuit.ts"
import { connectorsAt } from "../src/contract/space.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

// The subscription rover at 60×21 mm (15 Nov 2026): U5's VCP capacitor C4 is wired between two neighbouring pins
// (VCP, VM). Left to the router, VM's trace detoured 8.4-11.6 mm against its 5 mm bound, because I2C and GND traces
// took the gap between C3 and C4. Drawn by the generator they measured 2.1-4.3 mm in a real build.
const rover = (w: number, h: number): ContractSnapshot => {
	const s0 = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/cc-rover-60x21-rev17.json"), "utf8")) as ContractSnapshot
	const { sizeReason: _r, ...o } = s0.values.outline!
	return { ...s0, values: { ...s0.values, outline: { ...o, widthMm: w, heightMm: h }, connectors: connectorsAt(s0, w, h) } }
}

test("a capacitor between two pins of one part gets both its traces drawn, each within its bound", () => {
	const paths = capPaths(rover(60, 21))
	const of = (cap: string) => paths.filter((p) => p.cap === cap)
	for (const cap of ["C3", "C4"]) {
		assert.equal(of(cap).length, 2, `${cap}: both ends drawn`)
		for (const p of of(cap)) assert.ok(p.lengthMm <= p.boundMm, `${cap} ${p.pin}: ${p.lengthMm} mm against ${p.boundMm}`)
	}
	// The far end (VM) runs out along its own pad row, then to the terminal: never across the near end's trace.
	const vm = of("C4").find((p) => p.pin === "VM")!
	assert.ok(vm.lengthMm > of("C4").find((p) => p.pin === "VCP")!.lengthMm)
})

test("in the drawCaps retry the drawn traces go into the circuit as pcbPath, relative to the part they start from", () => {
	// Only in the retry that draws them: the default leaves every trace to the router.
	assert.doesNotMatch(circuitFromContract(rover(60, 21), { ldoFromUsbMm: 8 }), /pcbPath/)
	const src = circuitFromContract(rover(60, 21), { ldoFromUsbMm: 8, drawCaps: true })
	assert.match(src, /<trace name="U5_VM_C4" from="\.U5 > \.VM" to="\.C4 > \.pin2" pcbPath=\{\[/)
	assert.match(src, /<trace name="U5_VCP_C4" from="\.U5 > \.VCP" to="\.C4 > \.pin1" pcbPath=\{\[/)
	// Measured in the real build: U5 at (7.5, 4.5), VM's pad at (11.43, 4.18), C4's pin 2 at (14.51, 3): the corner at
	// the terminal's column on VM's row is (7.01, -0.32) from U5's origin.
	const m = /name="U5_VM_C4".*?pcbPath=\{\[\{ x: ([-\d.]+), y: ([-\d.]+) \}/.exec(src)!
	assert.ok(Math.abs(Number(m[1]) - 7.01) < 0.02 && Math.abs(Number(m[2]) + 0.32) < 0.02, m[0])
})

test("a capacitor on one pin, or across two sides of a part, is left to the router", () => {
	const paths = capPaths(rover(60, 21))
	assert.ok(paths.every((p) => p.cap === "C3" || p.cap === "C4"), paths.map((p) => p.cap).join(","))
})
