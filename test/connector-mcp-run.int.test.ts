// A design started the way the MCP server starts one (startRunProcess: `tsx src/main.ts <brief> --mock`, the
// server's environment) streams to Bringup Studio when this machine is logged in: a Claude Code user's runs show up.
import { test } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { startRunProcess } from "../src/runner/spawn-run.ts"
import { saveToken } from "../src/connector/login.ts"
import { tempDir } from "./helpers.ts"

test("start_design's run process streams the run to Studio when a token exists", { timeout: 300_000 }, async () => {
	const got = new Map<string, Set<string>>()
	const server = createServer((req, res) => {
		const m = /^\/api\/connector\/runs\/([^/]+)\/(sync|commands)/.exec(req.url ?? "")
		if (!m || req.headers.authorization !== "Bearer t0k") return void res.writeHead(404).end()
		if (m[2] === "commands") return void res.writeHead(200, { "content-type": "application/json" }).end('{"commands":[]}')
		let body = ""
		req.on("data", (c) => (body += c))
		req.on("end", () => {
			for (const c of JSON.parse(body).changes) (got.get(m[1]) ?? got.set(m[1], new Set()).get(m[1])!).add(c.path)
			res.writeHead(200).end("{}")
		})
	})
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
	const tokenFile = join(tempDir(), "studio.json")
	saveToken({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: "t0k", account: "tester" }, tokenFile)
	const before = process.env.BRINGUP_STUDIO_TOKEN_FILE
	process.env.BRINGUP_STUDIO_TOKEN_FILE = tokenFile
	try {
		const outDir = tempDir()
		const briefPath = join(outDir, "brief.md")
		writeFileSync(briefPath, "BLE temperature logger, USB-C, 50x30 mm\n")
		const run = startRunProcess({ briefPath, mock: true, outDir, extraArgs: ["--no-hardware"] })
		const { code } = await run.done
		assert.equal(code, 0)
		const files = got.get(basename(outDir))
		assert.ok(files, `nothing reached Studio for ${basename(outDir)} (got ${[...got.keys()].join(", ")})`)
		for (const f of ["contract.json", "trace.jsonl", "report.md"]) assert.ok(files!.has(f), `${f} not streamed: ${[...files!].join(", ")}`)
	} finally {
		if (before === undefined) delete process.env.BRINGUP_STUDIO_TOKEN_FILE
		else process.env.BRINGUP_STUDIO_TOKEN_FILE = before
		server.closeAllConnections()
		server.close()
	}
})
