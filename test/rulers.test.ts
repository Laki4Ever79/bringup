import assert from "node:assert/strict"
import { test } from "node:test"
import { axisMap, rulerTicks, tickStep } from "../src/dashboard/rulers.js"

test("tick step: 1/2/5 × 10ⁿ mm, labels about 80 px apart, minor ticks between", () => {
	// 10 px per mm: 5 mm = 50 px, 10 mm = 100 px; 10 mm is nearer 80 px in ratio.
	assert.deepEqual(tickStep(10), { major: 10, minor: 2 })
	// 4 px per mm: 20 mm = 80 px.
	assert.deepEqual(tickStep(4), { major: 20, minor: 5 })
	// Zoomed in, 200 px per mm: 0.5 mm = 100 px, 0.2 mm = 40 px.
	assert.deepEqual(tickStep(200), { major: 0.5, minor: 0.1 })
	// Zoomed out, 0.5 px per mm: 200 mm = 100 px.
	assert.deepEqual(tickStep(0.5), { major: 200, minor: 50 })
	for (const ppm of [0.3, 0.9, 2, 3.3, 7, 13, 26, 55, 120, 400]) {
		const px = tickStep(ppm).major * ppm
		assert.ok(px >= 50 && px <= 130, `${ppm} px/mm → labels ${px} px apart`)
	}
})

test("mm ↔ px on both axes: origin at the board's bottom-left corner, y up, tracking the view box", () => {
	// pcb-view's viewBox is in mm with svg y = −board y. Board corner at (−25, −15); the view shows x −30…30, svg y −20…20.
	const view = [-30, -20, 60, 40]
	const map = axisMap({ view, width: 600, height: 400, origin: { x: -25, y: -15 } })
	assert.equal(map.xPx(0), 50, "the board's left edge")
	assert.equal(map.xPx(50), 550, "50 mm along")
	assert.equal(map.yPx(0), 350, "the board's bottom edge, y up")
	assert.equal(map.yPx(30), 50)
	assert.equal(map.xMm(550), 50)
	assert.equal(map.yMm(50), 30)
	assert.equal(map.pxPerMm, 10)
	// Zoomed 2× about the centre: the mapping follows exactly.
	const zoomed = axisMap({ view: [-15, -10, 30, 20], width: 600, height: 400, origin: { x: -25, y: -15 } })
	assert.equal(zoomed.pxPerMm, 20)
	assert.equal(zoomed.xPx(25), 300)
	assert.equal(zoomed.yPx(15), 200)
})

test("ruler ticks cover the visible range, majors labelled, minors between, none outside", () => {
	const t = rulerTicks(-3.2, 21.7, { major: 10, minor: 2 })
	assert.deepEqual(t.filter((x) => x.major).map((x) => x.mm), [0, 10, 20])
	assert.deepEqual(t.filter((x) => !x.major).map((x) => x.mm), [-2, 2, 4, 6, 8, 12, 14, 16, 18])
	assert.equal(t.find((x) => x.mm === 10)?.label, "10")
	// Fractional steps keep clean labels.
	assert.deepEqual(rulerTicks(0.9, 2.1, { major: 0.5, minor: 0.1 }).filter((x) => x.major).map((x) => x.label), ["1", "1.5", "2"])
})

test("mm ↔ px when the view box and the element differ in aspect (SVG meet: uniform scale, centred)", () => {
	// A 60 × 40 mm view in an 800 × 400 px element: 10 px/mm, 100 px of empty margin either side.
	const map = axisMap({ view: [-30, -20, 60, 40], width: 800, height: 400, origin: { x: -25, y: -15 } })
	assert.equal(map.pxPerMm, 10)
	assert.equal(map.xPx(0), 150)
	assert.equal(map.yPx(0), 350)
	assert.equal(map.xMm(150), 0)
})
