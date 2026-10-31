import { test } from "node:test"
import assert from "node:assert/strict"
import { circuitIndex, diffRefs, fitTransform, netColor, PCB_COLORS } from "../src/dashboard/pcb-view.js"
import { boardMesh, boxTris, heightFor, orbitCamera, paintOrder, placeBoardInCase, project, shade } from "../src/dashboard/scene3d.js"

// A two-part board: U1 (a module) and R1, joined by net SDA (by source_net) and GND (by source_trace).
function circuit(r1x = 10) {
	return [
		{ type: "pcb_board", center: { x: 0, y: 0 }, width: 40, height: 20, thickness: 1.6, num_layers: 2 },
		{ type: "source_component", source_component_id: "sc0", name: "U1" },
		{ type: "source_component", source_component_id: "sc1", name: "R1" },
		{ type: "source_port", source_port_id: "sp0", source_component_id: "sc0", name: "GPIO8" },
		{ type: "source_port", source_port_id: "sp1", source_component_id: "sc1", name: "pin1" },
		{ type: "source_port", source_port_id: "sp2", source_component_id: "sc1", name: "pin2" },
		{ type: "source_net", source_net_id: "sn0", name: "SDA" },
		{ type: "source_net", source_net_id: "sn1", name: "GND" },
		{ type: "source_trace", source_trace_id: "st0", connected_source_port_ids: ["sp2"], connected_source_net_ids: ["sn1"] },
		{ type: "pcb_component", pcb_component_id: "pc0", source_component_id: "sc0", center: { x: -10, y: 0 }, width: 8, height: 6, layer: "top", rotation: 270 },
		{ type: "pcb_component", pcb_component_id: "pc1", source_component_id: "sc1", center: { x: r1x, y: 0 }, width: 2, height: 1, layer: "top", rotation: 0 },
		{ type: "pcb_port", pcb_port_id: "pp0", pcb_component_id: "pc0", source_port_id: "sp0", x: -6, y: 0 },
		{ type: "pcb_port", pcb_port_id: "pp1", pcb_component_id: "pc1", source_port_id: "sp1", x: r1x - 0.5, y: 0 },
		{ type: "pcb_port", pcb_port_id: "pp2", pcb_component_id: "pc1", source_port_id: "sp2", x: r1x + 0.5, y: 0 },
		{ type: "pcb_smtpad", pcb_component_id: "pc0", pcb_port_id: "pp0", layer: "top", shape: "rect", x: -6, y: 0, width: 1, height: 0.5 },
		{ type: "pcb_smtpad", pcb_component_id: "pc0", pcb_port_id: null, layer: "top", shape: "rect", x: -14, y: 3, width: 1, height: 0.5 },
		{ type: "pcb_smtpad", pcb_component_id: "pc1", pcb_port_id: "pp1", layer: "top", shape: "rect", x: r1x - 0.5, y: 0, width: 0.6, height: 0.6 },
		{ type: "pcb_smtpad", pcb_component_id: "pc1", pcb_port_id: "pp2", layer: "top", shape: "rect", x: r1x + 0.5, y: 0, width: 0.6, height: 0.6 },
		{
			type: "pcb_trace", pcb_trace_id: "t0", connection_name: "sn0", connectsTo: ["pp0", "pp1"],
			route: [
				{ route_type: "wire", x: -6, y: 0, width: 0.15, layer: "top" },
				{ route_type: "via", x: 0, y: 0, from_layer: "top", to_layer: "bottom" },
				{ route_type: "wire", x: 0, y: 0, width: 0.15, layer: "bottom" },
				{ route_type: "wire", x: r1x - 0.5, y: 0, width: 0.15, layer: "bottom" },
			],
		},
		{ type: "pcb_trace", pcb_trace_id: "t1", connection_name: "st0", connectsTo: ["pp2"], route: [{ route_type: "wire", x: r1x + 0.5, y: 0, width: 0.2, layer: "top" }, { route_type: "wire", x: 15, y: -5, width: 0.2, layer: "top" }] },
		{ type: "pcb_via", x: 0, y: 0, outer_diameter: 0.6, hole_diameter: 0.3 },
	]
}

test("net colours: GND slate, power rails red, signals stable and distinct", () => {
	assert.equal(netColor("GND", 0), PCB_COLORS.gnd)
	for (const power of ["V3V3", "VBUS", "VBAT", "3V3", "VCC"]) assert.equal(netColor(power, 1), PCB_COLORS.power, power)
	assert.equal(netColor("I2C_SDA", 0), netColor("I2C_SDA", 0))
	assert.notEqual(netColor("I2C_SDA", 0), netColor("I2C_SCL", 1))
	assert.notEqual(netColor("I2C_SDA", 0), PCB_COLORS.power)
})

test("circuitIndex resolves refs, nets by source_net or source_trace, and part outlines from pads", () => {
	const ix = circuitIndex(circuit())
	assert.deepEqual(ix.board, { cx: 0, cy: 0, w: 40, h: 20, thickness: 1.6, layers: 2 })
	assert.deepEqual(ix.components.map((c: { ref: string }) => c.ref), ["U1", "R1"])
	const u1 = ix.components[0]
	// Outline spans the pads (x -14..-6, y 0..3), padded, not the unrotated width/height.
	assert.ok(u1.x0 < -14 && u1.x1 > -6 && u1.y0 < 0 && u1.y1 > 3, JSON.stringify(u1))
	const t0 = ix.traces.find((t) => t.id === "t0")!
	assert.equal(t0.net, "SDA")
	assert.deepEqual(t0.refs.sort(), ["R1", "U1"])
	assert.equal(ix.traces.find((t) => t.id === "t1")!.net, "GND")
	assert.equal(ix.pads.filter((p) => p.ref === "R1").length, 2)
	assert.equal(ix.pads.find((p) => p.ref === "R1" && p.net === "GND")?.net, "GND")
	assert.equal(ix.vias.length, 1)
})

test("a via inside a route splits it into top and bottom segments", () => {
	const t0 = circuitIndex(circuit()).traces.find((t) => t.id === "t0")!
	assert.deepEqual(t0.segments.map((s: { layer: string }) => s.layer), ["top", "bottom"])
})

test("fitTransform centres the board, keeps aspect and flips y", () => {
	const f = fitTransform({ minX: -20, minY: -10, maxX: 20, maxY: 10 }, 1000, 1000, 50)
	assert.equal(f.scale, 22.5) // (1000 - 2·50) / 40
	assert.deepEqual(f.apply(0, 0), [500, 500])
	const [, yTop] = f.apply(0, 10)
	assert.ok(yTop < 500, "board +y is screen up")
	const g = fitTransform({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 400, 200, 0)
	assert.equal(g.scale, 20, "the tighter axis wins")
})

test("diffRefs reports parts that moved, appeared or were rewired", () => {
	assert.deepEqual(diffRefs(circuit(), circuit()), [])
	assert.deepEqual(diffRefs(circuit(10), circuit(12)), ["R1"])
	assert.deepEqual(diffRefs(null, circuit()).sort(), ["R1", "U1"])
	const rewired = circuit()
	// R1.pin1 moves from SDA to GND.
	;(rewired.find((e) => e.type === "source_trace") as { connected_source_port_ids: string[] }).connected_source_port_ids = ["sp1"]
	assert.deepEqual(diffRefs(circuit(), rewired), ["R1"])
})

test("component heights follow the role, or the ref prefix without parts", () => {
	assert.equal(heightFor("U1", "mcu"), 2.4)
	assert.equal(heightFor("U2", "sensor"), 0.8)
	assert.equal(heightFor("U3", "ldo"), 1.1)
	assert.equal(heightFor("J1", "usb-c"), 3.2)
	assert.equal(heightFor("R1", "resistor"), 0.5)
	assert.equal(heightFor("C4", undefined), 0.5)
	assert.equal(heightFor("J1", undefined), 3.2)
})

test("boxTris builds 12 outward-facing triangles", () => {
	const t = boxTris([0, 0, 0], [1, 2, 3])
	assert.equal(t.length, 12 * 9)
	// Every face normal points away from the box centre.
	for (let i = 0; i < t.length; i += 9) {
		const a = [t[i], t[i + 1], t[i + 2]], b = [t[i + 3], t[i + 4], t[i + 5]], c = [t[i + 6], t[i + 7], t[i + 8]]
		const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
		const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
		const mid = [(a[0] + b[0] + c[0]) / 3 - 0.5, (a[1] + b[1] + c[1]) / 3 - 1, (a[2] + b[2] + c[2]) / 3 - 1.5]
		assert.ok(n[0] * mid[0] + n[1] * mid[1] + n[2] * mid[2] > 0, `triangle ${i / 9} faces inward`)
	}
})

test("boardMesh: a slab of the board's size plus one box per part, each triangle tagged with its ref", () => {
	const m = boardMesh(circuit(), [{ ref: "U1", role: "mcu" }, { ref: "R1", role: "resistor" }])
	assert.equal(m.refs.length, m.positions.length / 9)
	assert.equal(m.kinds.length, m.refs.length)
	assert.equal(m.kinds.filter((k: string) => k === "slab").length, 12, "the slab")
	assert.equal(m.kinds.filter((k: string) => k === "pad").length, 2 * 4, "two triangles per top pad")
	assert.equal(m.refs.filter((r: string | null) => r === "U1").length, 12)
	assert.deepEqual([m.bounds.min[0], m.bounds.max[0]], [-20, 20])
	assert.equal(m.bounds.min[2], 0)
	assert.equal(Math.round(m.bounds.max[2] * 10) / 10, 4.0, "slab 1.6 + module 2.4")
})

test("placeBoardInCase centres the board in the case and rests it on the floor", () => {
	// Case from the enclosure frame: x -4..54, y -4..34, z 0..12 (wall 2, clearance 2, board 50×30 at the origin corner).
	const caseTris = new Float32Array([-4, -4, 0, 54, -4, 0, 54, 34, 12])
	const offset = placeBoardInCase(caseTris, { min: [-25, -15, 0], max: [25, 15, 1.6] })
	assert.deepEqual(offset, [25, 15, 2])
})

test("the camera projects its target to the screen centre and orders depth", () => {
	const cam = orbitCamera({ yaw: 0.6, pitch: 0.5, distance: 100, target: [10, 5, 2] })
	const [x, y] = project(cam, [10, 5, 2], 800, 600)
	assert.ok(Math.abs(x - 400) < 1e-6 && Math.abs(y - 300) < 1e-6)
	const near = project(cam, [cam.eye[0] * 0.5 + 5, cam.eye[1] * 0.5 + 2.5, cam.eye[2] * 0.5 + 1], 800, 600)[2]
	const far = project(cam, [10, 5, 2], 800, 600)[2]
	assert.ok(near < far, "points nearer the eye have smaller depth")
})

test("shade lights faces toward the light and keeps an ambient floor", () => {
	const lit = shade([100, 200, 50], [0, 0, 1], [0, 0, 1])
	const dark = shade([100, 200, 50], [0, 0, -1], [0, 0, 1])
	assert.deepEqual(lit, [100, 200, 50])
	assert.ok(dark[0] > 0 && dark[0] < 100)
})

test("the dashboard server serves both modules and the preview page", async () => {
	const { mkdtempSync } = await import("node:fs")
	const { tmpdir } = await import("node:os")
	const { join } = await import("node:path")
	const { serveDashboard } = await import("../src/dashboard/server.ts")
	const d = await serveDashboard(mkdtempSync(join(tmpdir(), "bringup-dash-")), 0)
	try {
		for (const m of ["/pcb-view.js", "/scene3d.js"]) {
			const r = await fetch(d.url + m)
			assert.equal(r.status, 200, m)
			assert.match(r.headers.get("content-type") ?? "", /javascript/)
			assert.match(await r.text(), /export function mount/)
		}
		const p = await fetch(d.url + "/preview")
		assert.equal(p.status, 200)
		assert.match(await p.text(), /mountPcb[\s\S]*mountScene/)
		assert.equal((await fetch(d.url + "/preview.html")).status, 404, "only the route, not the file name")
	} finally {
		await d.close()
	}
})

test("on standoffs the board's underside sits at the spec's floor plus post height", async () => {
	const { placeBoardInCase: place, enclosureFrame } = await import("../src/dashboard/scene3d.js")
	const spec = { wallMm: 2, heightMm: 14, standoff: { heightMm: 3, outerMm: 5, pilotMm: 1.6 }, lid: { plateMm: 2, lipMm: 3 } }
	const frame = enclosureFrame(spec)
	assert.deepEqual(frame, { boardZ: 5, lidTopZ: 16, postOuter: 5 })
	const caseTris = new Float32Array([-4, -4, 0, 54, -4, 0, 54, 34, 14])
	assert.deepEqual(place(caseTris, { min: [-25, -15, 0], max: [25, 15, 1.6] }, frame.boardZ), [25, 15, 5])
	assert.equal(enclosureFrame(null), null, "older runs have no spec: the board rests on the floor as before")
})

test("the lid's print pose is mirrored into place, and its triangles still face outward", async () => {
	const { assembleLid, triNormal: normal } = await import("../src/dashboard/scene3d.js")
	// The plate's outer face lies on the print bed, facing -z; once assembled it is the lid's top and must face +z.
	const printed = new Float32Array([0, 0, 0, 0, 10, 0, 10, 0, 0])
	assert.ok(normal(printed, 0)[2] < 0)
	const assembled = assembleLid(printed, 16)
	assert.deepEqual([assembled[2], assembled[5], assembled[8]], [16, 16, 16])
	assert.ok(normal(assembled, 0)[2] > 0, "winding swapped with the mirror")
})

test("standoff posts become one box each, from the floor to the board", async () => {
	const { postTris } = await import("../src/dashboard/scene3d.js")
	const tris = postTris([{ xMm: 3, yMm: 3, holeMm: 1.6 }, { xMm: 47, yMm: 27, holeMm: 1.6 }], 2, 5, 5)
	assert.equal(tris.length, 2 * 12 * 9)
	const zs = tris.filter((_: number, i: number) => i % 3 === 2)
	assert.deepEqual([Math.min(...zs), Math.max(...zs)], [2, 5])
	const xs = tris.slice(0, 12 * 9).filter((_: number, i: number) => i % 3 === 0)
	assert.deepEqual([Math.min(...xs), Math.max(...xs)], [0.5, 5.5])
})

// Seen on the dashboard (30 Oct): most parts vanished and the module's top was half drawn. The painter's sort used each
// triangle's centre, and a slab face of two 50 x 30 mm triangles has its centre nearer the camera than the parts on it.
test("from above, paint order is case behind, posts, board, pads, parts, then the case in front and the lid", () => {
	// depth along the view (larger is farther), the world normal's z, the centre's height
	const at = (kind: string, depth: number, nz = 0, z = 8) => ({ kind, depth, nz, z })
	const items = [
		at("part", 50), // a small part far back
		at("slab", 10, 1), // a huge slab triangle whose centre is near the camera
		at("pad", 40, 1),
		at("case", 90), // the far wall's inside
		at("case", 30, 1, 2), // the floor's inside: under the board, whatever its centre
		at("case", 31, 1, 5), // a floor the board rests on directly (no standoffs): still under it
		at("case", 12, 1, 14), // the walls' top rim: above the board, so it stays in depth order
		at("case", 5), // the near wall
		at("post", 45),
		at("part", 20),
		at("lid", 2),
	]
	const order = paintOrder(items, { boardDepth: 45, boardZ: 5, above: true }).map((e: { kind: string; depth: number }) => `${e.kind}@${e.depth}`)
	assert.deepEqual(order, ["case@90", "case@31", "case@30", "post@45", "slab@10", "pad@40", "part@50", "part@20", "case@12", "case@5", "lid@2"])
})

test("from below the board's plane, paint order falls back to depth alone", () => {
	const items = [{ kind: "slab", depth: 10, nz: 1, z: 2 }, { kind: "part", depth: 50, nz: 0, z: 3 }, { kind: "case", depth: 30, nz: 0, z: 7 }]
	assert.deepEqual(paintOrder(items, { boardDepth: 30, boardZ: 5, above: false }).map((e: { depth: number }) => e.depth), [50, 30, 10])
})


test("fitTransform keeps the board clear of the net legend: a bottom inset shrinks and lifts it", () => {
	const b = { minX: -20, minY: -10, maxX: 20, maxY: 10 }
	const plain = fitTransform(b, 1000, 600, 50)
	const f = fitTransform(b, 1000, 600, 50, 100)
	assert.ok(f.scale < plain.scale)
	// The board's centre sits in the middle of what's left above the legend, and its bottom edge clears it.
	assert.deepEqual(f.apply(0, 0).map((v) => Math.round(v)), [500, 250])
	assert.ok(f.apply(0, -10)[1] <= 600 - 100 - 50 + 1e-9)
})
