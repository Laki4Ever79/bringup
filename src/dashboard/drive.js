// The run page's Drive panel: the simulated drive (py/mech/drive.py) as a top-down SVG of the course, and its segments
// as rows. Pure, so the test runs it in node. Course (metres): walls at x = -1 and 1.5, y = ±1; the step from x = 0.6.
const ROOM = { x0: -1, x1: 1.5, y0: -1, y1: 1 }
const STEP_X = 0.6
const PX = 100 // pixels per metre

const sx = (x) => Math.round((x - ROOM.x0) * PX * 10) / 10
const sy = (y) => Math.round((ROOM.y1 - y) * PX * 10) / 10 // y is left: up on screen

export function driveSvg(trajectory, { edgeMm }) {
	const w = sx(ROOM.x1), h = sy(ROOM.y0)
	if (!Array.isArray(trajectory) || trajectory.length === 0) return `<div class="empty-state">no trajectory: the drive didn't run</div>`
	const pts = trajectory.map((r) => `${sx(r[1])},${sy(r[2])}`).join(" ")
	const [, ex, ey] = trajectory.at(-1)
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" class="drive-plot" role="img" aria-label="the simulated rover's path over the course">`,
		`<rect class="room" x="0" y="0" width="${w}" height="${h}" fill="none" stroke="currentColor" stroke-width="2"/>`,
		// A brief with no edge drives a flat room (py/mech/drive.py): no step band to draw.
		...(edgeMm > 0
			? [`<rect class="step" x="${sx(STEP_X)}" y="0" width="${Math.round((ROOM.x1 - STEP_X) * PX)}" height="${h}" fill="currentColor" opacity="0.08"/>`, `<text x="${sx(STEP_X) + 4}" y="12" font-size="9" fill="currentColor">${edgeMm} mm step</text>`]
			: [`<text x="4" y="12" font-size="9" fill="currentColor">flat floor</text>`]),
		`<polyline class="path" points="${pts}" fill="none" stroke="var(--accent, #e8590c)" stroke-width="2"/>`,
		`<circle cx="${sx(0)}" cy="${sy(0)}" r="3" fill="currentColor"/>`,
		`<circle cx="${sx(ex)}" cy="${sy(ey)}" r="3" fill="var(--accent, #e8590c)"/>`,
		`</svg>`,
	].join("")
}

export function driveRows(drive) {
	return (drive?.segments ?? []).map((s) => ({ name: s.name, verdict: s.pass ? "pass" : "FAIL", detail: s.detail }))
}
