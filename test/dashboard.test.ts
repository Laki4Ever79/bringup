import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { serveDashboard } from "../src/dashboard/server.ts"

const line = (seq: number) => ({ seq, at: new Date(1000 * seq).toISOString(), type: "contract.changed", producerId: "contract", payload: { field: "outline", version: seq, revision: seq, by: "architect" } })

function tempRun(lines: object[]): string {
	const dir = mkdtempSync(join(tmpdir(), "bringup-dash-"))
	writeFileSync(join(dir, "trace.jsonl"), lines.map((l) => JSON.stringify(l) + "\n").join(""))
	return dir
}

// Reads SSE `data:` payloads until `n` have arrived.
async function readEvents(url: string, n: number, onFirst?: () => void): Promise<any[]> {
	const res = await fetch(url)
	assert.equal(res.headers.get("content-type"), "text/event-stream")
	const reader = res.body!.getReader()
	const decoder = new TextDecoder()
	const got: any[] = []
	let buf = ""
	while (got.length < n) {
		const { value, done } = await reader.read()
		if (done) break
		buf += decoder.decode(value, { stream: true })
		let i
		while ((i = buf.indexOf("\n\n")) >= 0) {
			const frame = buf.slice(0, i)
			buf = buf.slice(i + 2)
			const data = frame.split("\n").find((l) => l.startsWith("data: "))
			if (data) {
				got.push(JSON.parse(data.slice(6)))
				if (got.length === 3) onFirst?.()
			}
		}
	}
	await reader.cancel()
	return got
}

test("events replays existing lines then streams appended ones", { timeout: 10_000 }, async () => {
	const dir = tempRun([line(1), line(2), line(3)])
	const dash = await serveDashboard(dir, 0)
	try {
		const got = await readEvents(`${dash.url}/events`, 4, () => appendFileSync(join(dir, "trace.jsonl"), JSON.stringify(line(4)) + "\n"))
		assert.deepEqual(got.map((e) => e.seq), [1, 2, 3, 4])
		assert.equal(got[3].type, "contract.changed")
	} finally {
		await dash.close()
	}
})

test("a line written in two chunks arrives once, whole", { timeout: 10_000 }, async () => {
	const dir = tempRun([line(1), line(2), line(3)])
	const dash = await serveDashboard(dir, 0)
	try {
		const text = JSON.stringify(line(4))
		const got = await readEvents(`${dash.url}/events`, 4, () => {
			appendFileSync(join(dir, "trace.jsonl"), text.slice(0, 10))
			setTimeout(() => appendFileSync(join(dir, "trace.jsonl"), text.slice(10) + "\n"), 50)
		})
		assert.equal(got[3].seq, 4)
	} finally {
		await dash.close()
	}
})

test("files under runDir are served, paths outside it are not", async () => {
	const dir = tempRun([])
	writeFileSync(join(dir, "contract.json"), '{"revision":3}')
	const dash = await serveDashboard(dir, 0)
	try {
		const base = dash.url
		const ok = await fetch(`${base}/files/contract.json`)
		assert.equal(ok.status, 200)
		assert.deepEqual(await ok.json(), { revision: 3 })
		for (const path of ["/files/../package.json", "/files/%2e%2e/package.json", "/files/..%2Fpackage.json"]) {
			const res = await fetch(base + path)
			assert.ok(res.status === 403 || res.status === 404, `${path} → ${res.status}`)
		}
		assert.equal((await fetch(`${base}/files/missing.png`)).status, 404)
	} finally {
		await dash.close()
	}
})

// fetch() normalises dot segments before sending, so these go out verbatim over node:http.
function rawStatus(base: string, path: string): Promise<number> {
	const { hostname, port } = new URL(base)
	return new Promise((ok, fail) => {
		const req = request({ hostname, port, path, method: "GET" }, (res) => {
			res.resume()
			ok(res.statusCode!)
		})
		req.on("error", fail)
		req.end()
	})
}

test("raw traversal paths cannot reach a file next to the run dir", async () => {
	const root = mkdtempSync(join(tmpdir(), "bringup-dash-root-"))
	writeFileSync(join(root, "secret.txt"), "secret")
	const dir = join(root, "run")
	mkdirSync(dir)
	symlinkSync(join(root, "secret.txt"), join(dir, "link.txt"))
	const dash = await serveDashboard(dir, 0)
	try {
		for (const path of ["/files/../secret.txt", "/files/%2e%2e/secret.txt", "/files/..%2fsecret.txt", "/files/..%5csecret.txt", "/files/%2e%2e%2fsecret.txt", "/files/link.txt"]) {
			const status = await rawStatus(dash.url, path)
			assert.ok(status === 403 || status === 404, `${path} → ${status}`)
		}
	} finally {
		await dash.close()
	}
})

test("the page is served at /", async () => {
	const dash = await serveDashboard(tempRun([]), 0)
	try {
		const res = await fetch(dash.url)
		assert.equal(res.status, 200)
		assert.match(await res.text(), /new EventSource\(`\$\{base\}\/events`\)/)
	} finally {
		await dash.close()
	}
})

test("the ripple module and the vendored fonts are served; nothing else from the fonts folder", async () => {
	const dash = await serveDashboard(tempRun([]), 0)
	try {
		const mod = await fetch(`${dash.url}/ripple.js`)
		assert.equal(mod.status, 200)
		assert.match(mod.headers.get("content-type") ?? "", /javascript/)
		for (const f of ["BigShouldersDisplay.woff", "InstrumentSans.woff", "JetBrainsMono.woff"]) {
			const res = await fetch(`${dash.url}/fonts/${f}`)
			assert.equal(res.status, 200, f)
			assert.equal(res.headers.get("content-type"), "font/woff")
			assert.ok((await res.arrayBuffer()).byteLength > 10_000)
		}
		for (const path of ["/fonts/OFL-BigShouldersDisplay.txt", "/fonts/nope.woff", "/fonts/../page.html", "/fonts/%2e%2e/server.ts"]) {
			const status = await rawStatus(dash.url, path)
			assert.ok(status === 403 || status === 404, `${path} → ${status}`)
		}
	} finally {
		await dash.close()
	}
})
