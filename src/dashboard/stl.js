// Tiny STL support for the dashboard's enclosure view: parse (binary or ASCII) and pick the feature edges
// (where the surface folds), so a wireframe shows the case's shape instead of its triangulation.
// Plain ES module with no dependencies, served at /stl.js and tested in Node.

// ArrayBuffer → Float32Array of triangle vertices: [x0 y0 z0 x1 y1 z1 x2 y2 z2, …]
export function parseStl(buffer) {
	const dv = new DataView(buffer)
	if (buffer.byteLength >= 84) {
		const n = dv.getUint32(80, true)
		if (84 + 50 * n === buffer.byteLength) {
			const out = new Float32Array(n * 9)
			for (let i = 0; i < n; i++) for (let j = 0; j < 9; j++) out[i * 9 + j] = dv.getFloat32(84 + i * 50 + 12 + j * 4, true)
			return out
		}
	}
	const text = new TextDecoder().decode(buffer)
	const nums = []
	for (const m of text.matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) nums.push(Number(m[1]), Number(m[2]), Number(m[3]))
	return new Float32Array(nums)
}

function normal(t, i) {
	const ax = t[i + 3] - t[i], ay = t[i + 4] - t[i + 1], az = t[i + 5] - t[i + 2]
	const bx = t[i + 6] - t[i], by = t[i + 7] - t[i + 1], bz = t[i + 8] - t[i + 2]
	const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx
	const len = Math.hypot(nx, ny, nz) || 1
	return [nx / len, ny / len, nz / len]
}

// Edges [[x,y,z],[x,y,z]] shared by faces that meet at more than `angleDeg`, plus open edges.
export function featureEdges(tris, angleDeg = 25) {
	const cos = Math.cos((angleDeg * Math.PI) / 180)
	const key = (x, y, z) => `${Math.round(x * 1000)},${Math.round(y * 1000)},${Math.round(z * 1000)}`
	const edges = new Map()
	for (let i = 0; i < tris.length; i += 9) {
		const n = normal(tris, i)
		for (let a = 0; a < 3; a++) {
			const b = (a + 1) % 3
			const pa = [tris[i + a * 3], tris[i + a * 3 + 1], tris[i + a * 3 + 2]]
			const pb = [tris[i + b * 3], tris[i + b * 3 + 1], tris[i + b * 3 + 2]]
			const ka = key(...pa), kb = key(...pb)
			const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
			const e = edges.get(k)
			if (e) e.normals.push(n)
			else edges.set(k, { a: pa, b: pb, normals: [n] })
		}
	}
	const out = []
	for (const e of edges.values()) {
		const [n1, n2] = e.normals
		if (!n2 || n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2] < cos) out.push([e.a, e.b])
	}
	return out
}
