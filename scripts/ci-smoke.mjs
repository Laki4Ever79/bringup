// The free tier on a fresh machine of each OS (.github/workflows/os-smoke.yml): install, typecheck, the MCP server's
// handshake, a mock design with no tools, then `setup board` and a mock design that builds the board and its pictures.
// Each step is timed, a failed step doesn't stop the rest, and the table goes to the job summary
// ($GITHUB_STEP_SUMMARY), or stdout when run by hand: node scripts/ci-smoke.mjs
import { spawn, spawnSync } from "node:child_process"
import { appendFileSync, existsSync, mkdtempSync, readdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const win = process.platform === "win32"
const steps = []
const out = mkdtempSync(join(tmpdir(), "bringup-ci-"))
const env = { ...process.env, BRINGUP_OUT: join(out, "runs"), BRINGUP_HOME: join(out, "home"), MOZAIK_CREDENTIALS_FILE: win ? "NUL" : "/dev/null" }

async function step(name, fn) {
	const t = Date.now()
	try {
		const note = (await fn()) ?? ""
		steps.push({ name, ok: true, s: (Date.now() - t) / 1000, note })
	} catch (e) {
		steps.push({ name, ok: false, s: (Date.now() - t) / 1000, note: String(e?.message ?? e).split("\n").slice(-3).join(" ").slice(0, 300) })
	}
}

// A command through the platform's shell (npm is npm.cmd on Windows), its output kept for a failure's note.
function sh(cmd, timeoutMs = 900_000) {
	const r = spawnSync(cmd, { shell: true, env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 })
	if (r.status !== 0) throw new Error(`${cmd} exited ${r.status ?? r.signal}: ${(r.stderr || r.stdout || "").trim()}`)
	return r.stdout
}

// The MCP server over stdio, as an MCP client starts it (`node bin/bringup-mcp.js`): JSON-RPC lines.
function mcp() {
	const p = spawn(process.execPath, ["bin/bringup-mcp.js"], { env, stdio: ["pipe", "pipe", "pipe"] })
	let buf = ""
	let err = ""
	const waiting = new Map()
	p.stderr.on("data", (d) => (err += d))
	p.stdout.on("data", (d) => {
		buf += d
		for (let i; (i = buf.indexOf("\n")) >= 0; ) {
			const line = buf.slice(0, i)
			buf = buf.slice(i + 1)
			if (!line.trim()) continue
			const msg = JSON.parse(line)
			if (msg.id !== undefined && waiting.has(msg.id)) (waiting.get(msg.id)(msg), waiting.delete(msg.id))
		}
	})
	let id = 0
	const call = (method, params, ms = 120_000) =>
		new Promise((ok, no) => {
			const n = ++id
			const timer = setTimeout(() => no(new Error(`${method}: no answer in ${ms / 1000} s; server stderr: ${err.slice(-500)}`)), ms)
			waiting.set(n, (m) => (clearTimeout(timer), ok(m)))
			p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n")
		})
	const tool = async (name, args) => {
		const r = await call("tools/call", { name, arguments: args })
		const text = r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? r)
		if (r.result?.isError) throw new Error(`${name}: ${text}`)
		return JSON.parse(text)
	}
	return { call, tool, close: () => p.kill(), stderr: () => err }
}

function files(dir) {
	const all = []
	const walk = (d) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const f = join(d, e.name)
			if (e.isDirectory()) e.name !== "node_modules" && walk(f)
			else all.push({ f, size: statSync(f).size })
		}
	}
	if (existsSync(dir)) walk(dir)
	return all
}

async function design(server, expectBoard) {
	const start = await server.tool("start_design", { brief: "BLE temperature logger, USB-C, 50x30 mm", mock: true })
	const t = Date.now()
	let st
	while (Date.now() - t < 30 * 60_000) {
		await new Promise((r) => setTimeout(r, 5000))
		st = await server.tool("design_status", { runId: start.runId })
		if (st.status !== "running" && st.status !== "installing") break
	}
	if (st?.status !== "settled") throw new Error(`ended ${st?.status} at revision ${st?.revision} with ${st?.violations?.length ?? "?"} violations ${st?.error ?? ""}; hardware: ${start.hardware}`)
	const fs = files(start.outDir)
	const pics = fs.filter((x) => /board(\.png|-pcb\.svg|-schematic\.svg)$/.test(x.f)).length
	const gerbers = fs.filter((x) => x.f.endsWith("gerbers.zip")).length
	if (expectBoard && !pics) throw new Error(`settled, but no board pictures (${fs.length} files); hardware: ${start.hardware}`)
	return `settled at revision ${st.revision}, ${fs.length} files, ${pics} board pictures, ${gerbers} gerber zips`
}

await step("npm ci", () => (sh("npm ci --no-audit --no-fund"), ""))
await step("typecheck", () => (sh("npm run typecheck"), ""))
const server = mcp()
await step("MCP handshake (initialize, tools/list)", async () => {
	const init = await server.call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ci-smoke", version: "0" } })
	const tools = await server.call("tools/list", {})
	return `${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version}, ${tools.result?.tools?.length} tools`
})
await step("mock design, no tools (design only)", () => design(server, false))
await step("setup board", () => (sh("node bin/bringup-mcp.js setup board", 1_200_000), files(join(out, "home")).length ? "installed into BRINGUP_HOME" : "nothing installed"))
await step("mock design with the board tools (board + pictures)", () => design(server, true))
server.close()

const md = [`### ${process.platform} ${process.arch}, Node ${process.versions.node}`, "", "| Step | Result | Time | Notes |", "|---|---|---|---|", ...steps.map((x) => `| ${x.name} | ${x.ok ? "pass" : "**FAIL**"} | ${x.s.toFixed(1)} s | ${x.note.replace(/\|/g, "/")} |`), ""].join("\n")
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n")
console.log(md)
process.exit(steps.every((x) => x.ok) ? 0 : 1)
