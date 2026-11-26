import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { compactOutline, connectorsAt, minimumBoard } from "../src/contract/space.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

// Taking the size the space model names, again and again (an architect resizing to it, the connectors carried along),
// settles: before (26 Nov 2026) the messages named minimumBoard's width × height, whose search is bounded by the current
// outline, and the arm board went 62×47 → 71×54 → 81×47 → 91×41 → 102×37 → 103×37 at the same area. compactOutline keeps
// the board's proportions and is a fixed point once reached.
const chain = (s: ContractSnapshot, steps: number) => {
	const sizes: string[] = []
	for (let i = 0; i < steps; i++) {
		const c = compactOutline(s)!
		sizes.push(`${c.widthMm}x${c.heightMm}`)
		s = { ...s, values: { ...s.values, connectors: connectorsAt(s, c.widthMm, c.heightMm), outline: { ...s.values.outline!, widthMm: c.widthMm, heightMm: c.heightMm } } }
	}
	return { sizes, s }
}
const load = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8")) as ContractSnapshot

test("the arm board's named size settles when taken again (it drifted to a strip before)", () => {
	const s = load("arm-board-test.json")
	const start = { ...s, values: { ...s.values, connectors: connectorsAt(s, 62, 47), outline: { ...s.values.outline!, widthMm: 62, heightMm: 47 } } }
	const { sizes, s: end } = chain(start, 3)
	assert.equal(sizes[1], sizes[2], sizes.join(" → "))
	// The settled board is within the slack rule of the minimum the rails' lanes set.
	const min = minimumBoard(end)!
	const [w, h] = sizes[2].split("x").map(Number)
	assert.ok(w * h <= min.areaMm2 * 1.15, `${sizes[2]} against ${min.areaMm2} mm²`)
})

test("a rover's named size settles too", () => {
	const { sizes } = chain(load("cc-eurobot-13-rev41.json"), 3)
	assert.equal(sizes[1], sizes[2], sizes.join(" → "))
})
