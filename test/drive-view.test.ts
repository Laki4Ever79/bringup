// The run page's Drive panel (src/dashboard/drive.js): the simulated trajectory over the course as an SVG, and the
// segments as rows.
import assert from "node:assert/strict"
import { test } from "node:test"
import { driveRows, driveSvg } from "../src/dashboard/drive.js"

const traj = [[0, 0, 0, 0, 0.66, 0.66, 0], [1, 0.3, 0, 0, 0.66, 0.66, 0], [2, 0.9, 0.05, 0.4, 0.66, -0.66, 3]]

test("the plot draws the room, the step and the path in course coordinates (x forward, y left: up on screen)", () => {
	const svg = driveSvg(traj, { edgeMm: 3 })
	assert.match(svg, /^<svg [^>]*viewBox="0 0 250 200"/)
	// 100 px per metre, the room from x = -1 to 1.5 and y = -1 to 1; y flips so left is up.
	assert.match(svg, /<rect class="room" x="0" y="0" width="250" height="200"/)
	assert.match(svg, /<rect class="step" x="160" y="0" width="90" height="200"/)
	assert.match(svg, /<polyline class="path" points="100,100 130,100 190,95"/)
	assert.match(svg, /3 mm step/)
})

test("no trajectory: an empty note instead of a plot", () => {
	assert.match(driveSvg([], { edgeMm: 3 }), /no trajectory/)
})

test("each segment is a row with its verdict", () => {
	const rows = driveRows({ result: "fail", segments: [{ name: "edge crossed", pass: false, detail: "the caster reached x = 0.58 m" }, { name: "turned away", pass: true, detail: "turned" }] })
	assert.deepEqual(rows, [{ name: "edge crossed", verdict: "FAIL", detail: "the caster reached x = 0.58 m" }, { name: "turned away", verdict: "pass", detail: "turned" }])
	assert.deepEqual(driveRows(null), [])
})
