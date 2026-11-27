// The connector against an in-process fake Bringup Studio (src/connector/client.ts, login.ts).
import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer, type IncomingMessage, type Server } from "node:http"
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { startConnector } from "../src/connector/client.ts"
import { login, readToken } from "../src/connector/login.ts"
import type { Command, FileChange } from "../src/connector/protocol.ts"
import { tempDir, waitFor } from "./helpers.ts"

const TOKEN = "tok-secret-123"

// A fake Studio: keeps each run's files as the connector sends them, serves queued commands, can go down.
function fakeStudio() {
	const files = new Map<string, Buffer>()
	const changes: FileChange[] = []
	const commands: Command[] = []
	let down = false
	let authBad = 0
	const body = (req: IncomingMessage) => new Promise<string>((r) => {
		let s = ""
		req.on("data", (c) => (s += c))
		req.on("end", () => r(s))
	})
	const server: Server = createServer(async (req, res) => {
		if (down) return req.socket.destroy()
		if (req.headers.authorization !== `Bearer ${TOKEN}`) {
			authBad++
			res.writeHead(401).end()
			return
		}
		const u = new URL(req.url!, "http://x")
		if (req.method === "POST" && u.pathname === "/api/connector/runs/run-1/sync") {
			const { changes: got } = JSON.parse(await body(req)) as { changes: FileChange[] }
			for (const c of got) {
				changes.push(c)
				if (c.kind === "delete") files.delete(c.path)
				else if (c.kind === "put") files.set(c.path, Buffer.from(c.data, "base64"))
				else {
					const prev = files.get(c.path) ?? Buffer.alloc(0)
					assert.equal(prev.length, c.offset, `append offset for ${c.path}`)
					files.set(c.path, Buffer.concat([prev, Buffer.from(c.data, "base64")]))
				}
			}
			res.writeHead(200, { "content-type": "application/json" }).end("{}")
			return
		}
		if (req.method === "GET" && u.pathname === "/api/connector/runs/run-1/commands") {
			const after = u.searchParams.get("after")
			const out = commands.filter((c) => !after || c.id > after)
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ commands: out }))
			return
		}
		res.writeHead(404).end()
	})
	return {
		files,
		changes,
		commands,
		get authBad() {
			return authBad
		},
		setDown: (v: boolean) => (down = v),
		start: () => new Promise<string>((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as { port: number }).port}`))),
		close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
	}
}

test("a run's contract and trace reach the fake server; a trace append is sent as an append", async () => {
	const s = fakeStudio()
	const url = await s.start()
	const dir = tempDir()
	writeFileSync(join(dir, "contract.json"), '{"revision":1}')
	writeFileSync(join(dir, "trace.jsonl"), '{"type":"run.started"}\n')
	const c = startConnector(dir, "run-1", { url, token: TOKEN, intervalMs: 50 })
	try {
		await waitFor(() => s.files.get("trace.jsonl")?.toString() === '{"type":"run.started"}\n')
		appendFileSync(join(dir, "trace.jsonl"), '{"type":"contract.changed"}\n')
		await waitFor(() => (s.files.get("trace.jsonl")?.toString() ?? "").endsWith('{"type":"contract.changed"}\n'))
		assert.ok(s.changes.some((x) => x.path === "trace.jsonl" && x.kind === "append"))
		assert.equal(s.files.get("contract.json")?.toString(), '{"revision":1}')
		// A build folder never goes up.
		const { mkdirSync } = await import("node:fs")
		mkdirSync(join(dir, "firmware", ".pio"), { recursive: true })
		writeFileSync(join(dir, "firmware", ".pio", "x.o"), "obj")
		writeFileSync(join(dir, "contract.json"), '{"revision":2}')
		await waitFor(() => s.files.get("contract.json")?.toString() === '{"revision":2}')
		assert.ok(![...s.files.keys()].some((k) => k.includes(".pio")))
	} finally {
		await c.stop()
		await s.close()
	}
})

test("a run that ends with more unsent than one batch: stop() sends every file, the drive results included", async () => {
	const studio = fakeStudio()
	const url = await studio.start()
	const dir = tempDir()
	// Started with a long interval, so the loop makes one pass and stop() has the rest to send: three 3.5 MB board files
	// (more than one 8 MB batch) and the simulated drive written at the end.
	const conn = startConnector(dir, "run-1", { url, token: TOKEN, intervalMs: 60_000 })
	await conn.synced()
	const { mkdirSync } = await import("node:fs")
	mkdirSync(join(dir, "board"), { recursive: true })
	mkdirSync(join(dir, "drive", "rev-3"), { recursive: true })
	for (const n of [1, 2, 3]) writeFileSync(join(dir, "board", `big-${n}.bin`), Buffer.alloc(3_500_000, n))
	writeFileSync(join(dir, "drive", "rev-3", "drive.json"), JSON.stringify({ result: "pass" }))
	writeFileSync(join(dir, "drive", "rev-3", "scorecard.json"), JSON.stringify({ revision: 3 }))
	try {
		await conn.stop()
		for (const f of ["board/big-1.bin", "board/big-2.bin", "board/big-3.bin", "drive/rev-3/drive.json", "drive/rev-3/scorecard.json"]) assert.ok(studio.files.has(f), `${f} reached Studio`)
	} finally { await studio.close() }
})

test("a command from the server lands in requests.jsonl, once, and survives a restart", async () => {
	const s = fakeStudio()
	const url = await s.start()
	const dir = tempDir()
	s.commands.push({ file: "requests.jsonl", line: JSON.stringify({ text: "make it 50 mm wide" }), id: "0001" })
	let c = startConnector(dir, "run-1", { url, token: TOKEN, intervalMs: 50 })
	try {
		await waitFor(() => existsSync(join(dir, "requests.jsonl")))
		await c.stop()
		// A connector started again on the same run: the applied ids are kept, nothing lands twice.
		c = startConnector(dir, "run-1", { url, token: TOKEN, intervalMs: 50 })
		s.commands.push({ file: "requests.jsonl", line: JSON.stringify({ text: "and 30 mm tall" }), id: "0002" })
		await waitFor(() => readFileSync(join(dir, "requests.jsonl"), "utf8").includes("30 mm"))
		const texts = readFileSync(join(dir, "requests.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).text)
		assert.deepEqual(texts, ["make it 50 mm wide", "and 30 mm tall"])
		// The connector's bookkeeping stays local.
		await c.synced()
		assert.ok(![...s.files.keys()].some((k) => k.startsWith(".studio")))
	} finally {
		await c.stop()
		await s.close()
	}
})

test("the server down for 3 s: the run goes on, and the connector catches up after", async () => {
	const s = fakeStudio()
	const url = await s.start()
	const dir = tempDir()
	writeFileSync(join(dir, "trace.jsonl"), "a\n")
	const logs: string[] = []
	const c = startConnector(dir, "run-1", { url, token: TOKEN, intervalMs: 50, log: (m) => logs.push(m) })
	try {
		await waitFor(() => s.files.get("trace.jsonl")?.toString() === "a\n")
		s.setDown(true)
		// The run keeps writing while Studio is gone; nothing here throws or waits on the connector.
		for (const l of ["b\n", "c\n", "d\n"]) {
			appendFileSync(join(dir, "trace.jsonl"), l)
			await new Promise((r) => setTimeout(r, 1000))
		}
		writeFileSync(join(dir, "contract.json"), '{"revision":3}')
		s.setDown(false)
		await waitFor(() => s.files.get("trace.jsonl")?.toString() === "a\nb\nc\nd\n" && s.files.get("contract.json")?.toString() === '{"revision":3}', 40_000)
		assert.equal(logs.filter((l) => /unreachable/.test(l)).length >= 1, true)
		assert.ok(!logs.join("\n").includes(TOKEN), "the token is never logged")
	} finally {
		await c.stop()
		await s.close()
	}
})

test("no token: the run sends nothing (main.ts starts the connector only with a token and without --offline)", async () => {
	const { studioConnector } = await import("../src/connector/client.ts")
	const s = fakeStudio()
	const url = await s.start()
	const dir = tempDir()
	writeFileSync(join(dir, "contract.json"), "{}")
	try {
		assert.equal(studioConnector(dir, "run-1", { offline: false, token: null }), null)
		assert.equal(studioConnector(dir, "run-1", { offline: true, token: { url, token: TOKEN, account: "a" } }), null)
		await new Promise((r) => setTimeout(r, 300))
		assert.equal(s.changes.length, 0)
		assert.equal(s.authBad, 0)
		const on = studioConnector(dir, "run-1", { offline: false, token: { url, token: TOKEN, account: "a" }, intervalMs: 50 })
		assert.ok(on)
		await waitFor(() => s.files.has("contract.json"))
		await on.stop()
	} finally {
		await s.close()
	}
})

test("bringup login: the device code is shown, the token is written 0600 and never printed", async () => {
	const said: string[] = []
	let polls = 0
	const fake: typeof fetch = (async (u: string, init?: RequestInit) => {
		if (u.endsWith("/api/connector/pair")) return Response.json({ deviceCode: "dev-1", userCode: "ABCD-1234", verifyUrl: "https://studio.example/pair", intervalS: 1, expiresInS: 60 })
		if (u.endsWith("/api/connector/pair/poll")) {
			assert.deepEqual(JSON.parse(String(init!.body)), { deviceCode: "dev-1" })
			return ++polls < 3 ? Response.json({ pending: true }, { status: 202 }) : Response.json({ token: TOKEN, account: "aleksa" })
		}
		return new Response("", { status: 404 })
	}) as unknown as typeof fetch
	const path = join(tempDir(), "nested", "studio.json")
	let opened = ""
	const r = await login("https://studio.example/", (u) => (opened = u), { fetch: fake, path, say: (m) => said.push(m), sleep: async () => {} })
	assert.deepEqual(r, { account: "aleksa" })
	assert.equal(opened, "https://studio.example/pair")
	assert.match(said.join("\n"), /ABCD-1234/)
	assert.ok(!said.join("\n").includes(TOKEN))
	assert.equal(statSync(path).mode & 0o777, 0o600)
	assert.deepEqual(readToken(path), { url: "https://studio.example", token: TOKEN, account: "aleksa" })
})

test("bringup login without Studio's address says how to give it; logout without a token says so", async () => {
	const { main } = await import("../src/main.ts")
	const before = process.env.BRINGUP_STUDIO_TOKEN_FILE
	process.env.BRINGUP_STUDIO_TOKEN_FILE = join(tempDir(), "none.json")
	const errs: string[] = []
	const err = console.error
	const out = console.log
	console.error = (m: string) => errs.push(m)
	console.log = (m: string) => errs.push(m)
	try {
		if (!process.env.BRINGUP_STUDIO_URL) assert.equal(await main(["login"]), 1)
		assert.equal(await main(["logout"]), 0)
	} finally {
		console.error = err
		console.log = out
		if (before === undefined) delete process.env.BRINGUP_STUDIO_TOKEN_FILE
		else process.env.BRINGUP_STUDIO_TOKEN_FILE = before
	}
	if (!process.env.BRINGUP_STUDIO_URL) assert.match(errs.join("\n"), /--url <https:\/\/\.\.\.> or BRINGUP_STUDIO_URL/)
	assert.match(errs.join("\n"), /wasn't connected to Bringup Studio/)
})
