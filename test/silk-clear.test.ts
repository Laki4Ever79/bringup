import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { clipRoute, clearSilk, padBoxes, SILK_PAD_CLEAR_MM } from "../src/codegen/silk-clear.ts"
import { circuitFromContract } from "../src/codegen/circuit.ts"
import { CNC_DESIGN, CNC_MACHINE, CNC_TARGETS } from "../src/inference/scripts.ts"
import { fixtureContract } from "./fixture.ts"

// The nearest a segment comes to a box (0 when it crosses it).
const gap = (a: { x: number; y: number }, b: { x: number; y: number }, k: { x0: number; y0: number; x1: number; y1: number }) => {
	let best = Infinity
	for (let i = 0; i <= 200; i++) {
		const t = i / 200
		const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t
		best = Math.min(best, Math.hypot(Math.max(k.x0 - x, 0, x - k.x1), Math.max(k.y0 - y, 0, y - k.y1)))
	}
	return best
}
// Every generated footprint's silkscreen against its own pads.
const offenders = (code: string) => {
	const out: string[] = []
	for (const m of code.matchAll(/name="([^"]+)"[^\n]*?footprint=(\{<footprint>.*?<\/footprint>\})/g)) {
		const pads = padBoxes(m[2])
		for (const s of m[2].matchAll(/<silkscreenpath route=\{\[([^\]]*)\]\} \/>/g)) {
			const pts = [...s[1].matchAll(/x:\s*(-?[\d.]+),\s*y:\s*(-?[\d.]+)/g)].map((p) => ({ x: Number(p[1]), y: Number(p[2]) }))
			for (let i = 0; i + 1 < pts.length; i++) for (const k of pads) if (gap(pts[i], pts[i + 1], k) < SILK_PAD_CLEAR_MM - 1e-3) out.push(`${m[1]} ${JSON.stringify(pts[i])}`)
		}
	}
	return [...new Set(out)]
}

test("an outline crossing a pad is cut there, the clearance kept, and the rest stays one line", () => {
	// The inductor case (lead-2, 27 Nov 2026): a 7.5×7 outline, end pads reaching x = ±3.99.
	const route = [{ x: -3.75, y: -3.5 }, { x: 3.75, y: -3.5 }, { x: 3.75, y: 3.5 }, { x: -3.75, y: 3.5 }, { x: -3.75, y: -3.5 }]
	const pads = [{ x0: -3.988, x1: -1.838, y0: -1.66, y1: 1.66 }, { x0: 1.838, x1: 3.988, y0: -1.66, y1: 1.66 }]
	const lines = clipRoute(route, pads)
	assert.equal(lines.length, 2, "the left and right sides are cut at the pads: two runs remain")
	for (const l of lines) for (let i = 0; i + 1 < l.length; i++) for (const k of pads) assert.ok(gap(l[i], l[i + 1], k) >= SILK_PAD_CLEAR_MM - 1e-3)
	assert.deepEqual(lines.map((l) => l.length), [4, 4], "each run goes from one pad cut round both corners to the other (the top and the bottom side stay whole)")
})

test("an outline clear of its pads is left exactly as it was", () => {
	const fp = `{<footprint><smtpad portHints={["pin1"]} pcbX="0mm" pcbY="0mm" width="1mm" height="1mm" shape="rect" /><silkscreenpath route={[{ x: -2, y: -2 }, { x: 2, y: -2 }, { x: 2, y: 2 }, { x: -2, y: 2 }, { x: -2, y: -2 }]} /></footprint>}`
	assert.equal(clearSilk(fp), fp)
})

test("no generated footprint draws silkscreen over its own pads (rover, arm, CNC)", () => {
	const rover = JSON.parse(readFileSync(new URL("./fixtures/rover-mock-rev11.json", import.meta.url), "utf8"))
	const arm = JSON.parse(readFileSync(new URL("./fixtures/arm-mock-rev14.json", import.meta.url), "utf8"))
	const base = fixtureContract()
	const cnc = { ...base, values: { ...base.values, ...CNC_DESIGN, cncTargets: CNC_TARGETS, cnc: CNC_MACHINE } }
	for (const [name, s] of [["rover", rover], ["arm", arm], ["cnc", cnc]] as const) {
		const code = circuitFromContract(s as never)
		assert.ok(/<silkscreenpath/.test(code), `${name} has generated outlines`)
		assert.deepEqual(offenders(code), [], name)
	}
})
