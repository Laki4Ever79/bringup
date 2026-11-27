// The free tier on a fresh machine of each OS (.github/workflows/os-smoke.yml): install, typecheck, the MCP server's
// handshake, a mock design with no tools, then each setup domain and a design that needs it: the board and its
// pictures, a rover's printed parts and ROS workspace, a firmware build; then the newcomer's MCP path on that design:
// run_summary, get_pictures (the board as an image, the stills of it in its case) and export_package.
// Each step is timed, a failed step doesn't stop the rest, and the table goes to the job summary
// ($GITHUB_STEP_SUMMARY), or stdout when run by hand: node scripts/ci-smoke.mjs
// --packed: what a user installs, not this checkout: `npm pack`, the .tgz installed into an empty folder, then every
// setup domain, the firmware design and the newcomer's MCP path through that copy (`npx bringup-mcp`).
import { spawn, spawnSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { createServer } from "node:http"
import { basename, join } from "node:path"

const win = process.platform === "win32"
const steps = []
const out = mkdtempSync(join(tmpdir(), "bringup-ci-"))
// BRINGUP_TOOLCHAIN=local: the npx user's path, not Docker's toolchain image (GitHub's Linux runners have Docker).
// --newcomer-only: this machine's installed tools, no installs: the handshake, one design and the newcomer's MCP path
// after it (a quick check by hand of the steps a fresh runner takes the whole way).
const only = process.argv.includes("--newcomer-only")
const packed = process.argv.includes("--packed")
// The user's folder holding the installed package (--packed); the server and setup run from there.
const user = join(out, "user")
// BRINGUP_STUDIO_TOKEN_FILE: `login` against the fake Studio below writes its token here, never over a real one in ~/.bringup.
const env = { ...process.env, BRINGUP_STUDIO_TOKEN_FILE: join(out, "studio.json"), BRINGUP_OUT: join(out, "runs"), ...(only ? {} : { BRINGUP_HOME: join(out, "home") }), BRINGUP_TOOLCHAIN: "local", MOZAIK_CREDENTIALS_FILE: win ? "NUL" : "/dev/null" }

async function step(name, fn) {
	const t = Date.now()
	try {
		const note = (await fn()) ?? ""
		steps.push({ name, ok: true, s: (Date.now() - t) / 1000, note })
	} catch (e) {
		const text = String(e?.message ?? e)
		// The whole output in the job log; in the table the lines that say what went wrong (npm's "npm error …", a
		// thrown error's first lines), not its last lines.
		console.log(`--- ${name} failed ---\n${text}\n---`)
		const telling = text.split("\n").filter((l) => /error|ERR_|EBAD|not provide|cannot|failed/i.test(l) && !/A complete log|npm help/.test(l))
		steps.push({ name, ok: false, s: (Date.now() - t) / 1000, note: (telling.length ? telling.slice(0, 3) : text.split("\n").slice(0, 3)).join(" ").slice(0, 400) })
	}
}

// A command through the platform's shell (npm is npm.cmd on Windows), its output kept for a failure's note.
function sh(cmd, timeoutMs = 900_000, cwd = undefined) {
	const r = spawnSync(cmd, { shell: true, env, cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 })
	if (r.status !== 0) throw new Error(`${cmd} exited ${r.status ?? r.signal}: ${(r.stderr || r.stdout || "").trim()}`)
	return r.stdout
}

// The MCP server over stdio, as an MCP client starts it (`node bin/bringup-mcp.js`, or `npx bringup-mcp` in the
// user's folder with --packed): JSON-RPC lines.
function mcp() {
	const p = packed
		? spawn("npx --no-install bringup-mcp", { shell: true, cwd: user, env, stdio: ["pipe", "pipe", "pipe"] })
		: spawn(process.execPath, ["bin/bringup-mcp.js"], { env, stdio: ["pipe", "pipe", "pipe"] })
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
	const tool = async (name, args, ms) => {
		const r = await call("tools/call", { name, arguments: args }, ms)
		const text = r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? r)
		if (r.result?.isError) throw new Error(`${name}: ${text}`)
		return JSON.parse(text)
	}
	// The whole result: a picture comes back as image content beside the text.
	const raw = async (name, args, ms) => {
		const r = await call("tools/call", { name, arguments: args }, ms)
		if (r.result?.isError || !r.result) throw new Error(`${name}: ${r.result?.content?.[0]?.text ?? JSON.stringify(r.error ?? r)}`)
		return r.result
	}
	// Closing stdin ends the server even when npx's shell stands between (killing the shell alone may not).
	return { call, tool, raw, close: () => (p.stdin.end(), p.kill()), stderr: () => err }
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

// A command line of the bringup-mcp CLI (this checkout's, or the installed copy's with --packed), without blocking: the
// fake Studio answers in this same process while it runs.
function cli(args, timeoutMs = 120_000) {
	return new Promise((ok, no) => {
		const p = packed ? spawn(`npx --no-install bringup-mcp ${args}`, { shell: true, cwd: user, env }) : spawn(process.execPath, ["bin/bringup-mcp.js", ...args.split(" ")], { env })
		let text = ""
		p.stdout.on("data", (d) => (text += d))
		p.stderr.on("data", (d) => (text += d))
		const timer = setTimeout(() => (p.kill(), no(new Error(`bringup-mcp ${args}: no exit in ${timeoutMs / 1000} s: ${text}`))), timeoutMs)
		p.on("close", (code) => (clearTimeout(timer), code === 0 ? ok(text) : no(new Error(`bringup-mcp ${args} exited ${code}: ${text}`))))
	})
}

// A fake Bringup Studio on localhost (the real server, cloud/, is private): the connector's side of the protocol
// (src/connector): device-code pairing (pending once, then approved), each run's file changes kept by run id, and one
// command per run sent back down (the robot's stop, "H 0 0", into bench-commands.jsonl) to prove the write-back.
function fakeStudio() {
	const TOKEN = "ci-smoke-token"
	const got = new Map()
	const commanded = new Set()
	let polls = 0
	const json = (res, code, body) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body))
	const server = createServer((req, res) => {
		let body = ""
		req.on("data", (c) => (body += c))
		req.on("end", () => {
			const url = req.url ?? ""
			if (url === "/api/connector/pair") return json(res, 200, { deviceCode: "dc-1", userCode: "CISM-0KE1", verifyUrl: `${base}/verify`, intervalS: 1, expiresInS: 60 })
			if (url === "/api/connector/pair/poll") return ++polls < 2 ? json(res, 202, { pending: true }) : json(res, 200, { token: TOKEN, account: "ci-smoke" })
			if (url === "/verify") return res.writeHead(200).end("approved")
			const m = /^\/api\/connector\/runs\/([^/?]+)\/(sync|commands)/.exec(url)
			if (!m) return json(res, 404, {})
			if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: "bad token" })
			const run = decodeURIComponent(m[1])
			if (m[2] === "sync") {
				for (const c of JSON.parse(body).changes) (got.get(run) ?? got.set(run, new Set()).get(run)).add(c.path)
				return json(res, 200, {})
			}
			if (!commanded.has(run)) return (commanded.add(run), json(res, 200, { commands: [{ file: "bench-commands.jsonl", line: JSON.stringify({ at: new Date().toISOString(), cmd: "H 0 0" }), id: "ci-1" }] }))
			setTimeout(() => json(res, 200, { commands: [] }), 1000)
		})
	})
	let base = ""
	const ready = new Promise((r) => server.listen(0, "127.0.0.1", () => ((base = `http://127.0.0.1:${server.address().port}`), r())))
	return { ready, url: () => base, got, close: () => (server.closeAllConnections(), server.close()) }
}

const LOGGER = "BLE temperature logger, USB-C, 50x30 mm"
// expect: what the run must have made (board pictures, printed parts, the ROS workspace, a firmware image).
// The last design started, for the steps after it (run_summary, get_pictures, export_package).
let lastRun = null
async function design(server, expect = {}, brief = LOGGER) {
	const start = await server.tool("start_design", { brief, mock: true })
	lastRun = start
	const t = Date.now()
	let st
	while (Date.now() - t < 45 * 60_000) {
		await new Promise((r) => setTimeout(r, 5000))
		st = await server.tool("design_status", { runId: start.runId })
		if (st.status !== "running" && st.status !== "installing") break
	}
	if (st?.status !== "settled") {
		// What kept it from settling: the violations, and the last failed build's own error from the run's trace.
		const v = (st?.violations ?? []).map((x) => `${x.kind}: ${x.message}`).join(" / ")
		let failed = ""
		try {
			const tr = readFileSync(join(start.outDir, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
			const f = tr.filter((e) => e.type === "artifact.failed").at(-1)
			if (f) failed = ` | last failed build: ${f.payload.kind} rev ${f.payload.revision}: ${String(f.payload.error ?? "").slice(0, 1500)}`
		} catch {}
		throw new Error(`ended ${st?.status} at revision ${st?.revision} with ${st?.violations?.length ?? "?"} violations: ${v} ${st?.error ?? ""}; hardware: ${start.hardware}${failed}`)
	}
	const fs = files(start.outDir)
	const pics = fs.filter((x) => /board(\.png|-pcb\.svg|-schematic\.svg)$/.test(x.f)).length
	const gerbers = fs.filter((x) => x.f.endsWith("gerbers.zip")).length
	const printed = fs.filter((x) => /\.(stl|step)$/.test(x.f) && !/[\\/]board[\\/]/.test(x.f)).length
	const ros = fs.filter((x) => /[\\/]ros[\\/]src[\\/].*\.urdf$/.test(x.f)).length
	const firmware = fs.filter((x) => /firmware\.bin$/.test(x.f)).length
	// Where the time went: each builder's total build time from the trace (artifact events carry ms).
	let builds = ""
	try {
		const per = {}
		for (const e of readFileSync(join(start.outDir, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)))
			if ((e.type === "artifact.ready" || e.type === "artifact.failed") && typeof e.payload.ms === "number") per[e.payload.kind] = (per[e.payload.kind] ?? 0) + e.payload.ms
		builds = Object.entries(per).sort((a, b) => b[1] - a[1]).map(([k, ms]) => `${k} ${Math.round(ms / 1000)} s`).join(", ")
		// Whether the builds overlap: each one's [end - ms, end]; the time with any build running, with two or more, and the
		// run's wall time (run 9: Windows' builds summed about its wall time, Linux's to twice it).
		const tr = readFileSync(join(start.outDir, "trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
		const spans = tr.filter((e) => (e.type === "artifact.ready" || e.type === "artifact.failed") && e.payload.ms > 0).map((e) => [Date.parse(e.at) - e.payload.ms, Date.parse(e.at)])
		const edges = spans.flatMap(([a, z]) => [[a, 1], [z, -1]]).sort((x, y) => x[0] - y[0] || x[1] - y[1])
		let n = 0, last = 0, any = 0, two = 0
		for (const [t, d] of edges) {
			if (n >= 1) any += t - last
			if (n >= 2) two += t - last
			n += d
			last = t
		}
		const wall = Date.parse(tr.at(-1).at) - Date.parse(tr[0].at)
		builds += `; wall ${Math.round(wall / 1000)} s, a build running ${Math.round(any / 1000)} s, two or more at once ${Math.round(two / 1000)} s`
	} catch {}
	// The simulated drive: the drive builder's newest drive/rev-N/drive.json (pass, fail, or not run and why); the ROS
	// acceptance writes its own elsewhere.
	const drives = fs.filter((x) => /[\\/]drive[\\/]rev-\d+[\\/]drive\.json$/.test(x.f)).sort((a, b) => statSync(a.f).mtimeMs - statSync(b.f).mtimeMs)
	const drive = drives.length ? JSON.parse(readFileSync(drives.at(-1).f, "utf8")) : null
	const said = `settled at revision ${st.revision}${builds ? ` (builds: ${builds})` : ""}, ${fs.length} files, ${pics} board pictures, ${gerbers} gerber zips, ${printed} printed-part files, ${ros} URDFs, ${firmware} firmware images${drive ? `, drive ${drive.result}${drive.topSpeedMps ? ` (top ${drive.topSpeedMps.toFixed(2)} m/s)` : ""}` : ""}`
	if (expect.drive && drive?.result !== "pass") throw new Error(`settled, but the MuJoCo drive ${drive ? `${drive.result}: ${drive.reason || (drive.segments ?? []).filter((x) => !x.pass).map((x) => `${x.name}: ${x.detail}`).join("; ")}` : "never ran"}; ${said}`)
	const missing = [expect.board && !pics && "board pictures", expect.printed && !printed && "printed parts", expect.ros && !ros && "the ROS workspace", expect.firmware && !firmware && "a firmware image"].filter(Boolean)
	if (missing.length) throw new Error(`settled, but no ${missing.join(", ")}: ${said}; hardware: ${start.hardware}`)
	return said
}

// The setup command: this checkout's, or the installed copy's.
const setup = (domain) => (packed ? sh(`npx --no-install bringup-mcp setup ${domain}`, 1_800_000, user) : sh(`node bin/bringup-mcp.js setup ${domain}`, 1_800_000), "")
if (packed) {
	await step("npm pack, installed into an empty folder", () => {
		const tgz = sh(`npm pack --pack-destination "${out}"`).trim().split(/\r?\n/).at(-1).trim()
		mkdirSync(user)
		sh("npm init -y", 60_000, user)
		sh(`npm install "${join(out, tgz)}" --no-audit --no-fund`, 900_000, user)
		const bin = join(user, "node_modules", ".bin", win ? "bringup-mcp.cmd" : "bringup-mcp")
		if (!existsSync(bin)) throw new Error(`installed, but no ${bin}`)
		return `${tgz}, ${Math.round(statSync(join(out, tgz)).size / 1024)} kB`
	})
} else if (!only) {
	await step("npm ci", () => (sh("npm ci --no-audit --no-fund"), ""))
	await step("typecheck", () => (sh("npm run typecheck"), ""))
}
const studio = fakeStudio()
await studio.ready
// `bringup login` before the last design, so that design streams to Studio; checked after the newcomer's path.
const login = () => step("bringup-mcp login (a fake Studio on localhost)", async () => {
	const said = await cli(`login --url ${studio.url()}`)
	const t = JSON.parse(readFileSync(env.BRINGUP_STUDIO_TOKEN_FILE, "utf8"))
	if (t.url !== studio.url() || !t.token) throw new Error(`login saved no token for ${studio.url()}: ${said}`)
	return said.trim().split(/\r?\n/).at(-1).replace(/ \(token in .*\)/, "")
})
const server = mcp()
await step("MCP handshake (initialize, tools/list)", async () => {
	const init = await server.call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ci-smoke", version: "0" } })
	const tools = await server.call("tools/list", {})
	return `${init.result?.serverInfo?.name} ${init.result?.serverInfo?.version}, ${tools.result?.tools?.length} tools`
})
// With --newcomer-only too (a check by hand): this machine's installed tools, no setups.
if (packed && !only) {
	for (const d of ["board", "case", "firmware"]) await step(`setup ${d}`, () => setup(d))
} else if (!packed && !only) {
await step("mock design, no tools (design only)", () => design(server))
await step("setup board", () => (sh("node bin/bringup-mcp.js setup board", 1_200_000), files(join(out, "home")).length ? "installed into BRINGUP_HOME" : "nothing installed"))
await step("mock design with the board tools (board + pictures)", () => design(server, { board: true }))
// The case's CAD kernel (build123d); PlatformIO (the first firmware build fetches the chip's platform and compiler);
// MuJoCo and Espressif's QEMU. Then a robot: its chassis as printed parts, its ROS 2 workspace, and its own firmware in
// QEMU driving the MuJoCo model over the course.
await step("setup case", () => setup("case"))
await step("setup firmware", () => setup("firmware"))
await step("setup sim", () => setup("sim"))
await step("mock rover (printed parts, ROS workspace, MuJoCo drive)", () => design(server, { board: true, printed: true, ros: true, drive: true }, readFileSync("briefs/rover.md", "utf8")))
}
await login()
await step("mock design with the firmware tools (firmware built)", () => design(server, { board: true, firmware: true }))
// The newcomer's path after that design, all through the MCP as Claude Code drives it: what was built, show me, the
// package to order and print from.
const need = () => {
	if (!lastRun) throw new Error("no design to look at (the design step didn't start)")
	return lastRun.runId
}
await step("run_summary", async () => {
	const s = await server.tool("run_summary", { runId: need() })
	const built = s.boards[0].artifacts.filter((a) => /^built|print check ok/.test(a.verdict)).map((a) => a.what)
	if (!built.includes("board") || !built.includes("case")) throw new Error(`board and case not both built: ${s.text}`)
	return `${s.status}; built ${built.join(", ")}; ${s.files.length} files`
})
await step("get_pictures (board picture as an image)", async () => {
	const r = await server.raw("get_pictures", { runId: need() })
	const listed = JSON.parse(r.content[0].text)
	const images = r.content.filter((c) => c.type === "image" && c.mimeType === "image/png" && c.data.length > 1000)
	if (!images.length) throw new Error(`no image content: ${r.content[0].text.slice(0, 600)}`)
	const want = ["board.png", "case.stl"].filter((f) => !listed.files.some((x) => x.path.endsWith(f)))
	if (want.length) throw new Error(`missing ${want.join(", ")}: ${r.content[0].text.slice(0, 600)}`)
	return `${images.length} image(s), ${listed.files.length} files`
})
await step("get_pictures stills: true (the board in its case)", async () => {
	const r = await server.raw("get_pictures", { runId: need(), stills: true }, 600_000)
	const listed = JSON.parse(r.content[0].text)
	const stills = listed.files.filter((x) => x.what.startsWith("3D still"))
	if (!stills.some((x) => x.path.endsWith("exploded.png"))) throw new Error(`no exploded still: ${r.content[0].text.slice(0, 800)}`)
	return `${stills.length} stills, ${r.content.filter((c) => c.type === "image").length} inline`
})
await step("export_package (fab, BOM, case, pictures, firmware)", async () => {
	// A mock design packages without force, its README opening with the scripted-review banner.
	const p = await server.tool("export_package", { runId: need() }, 1_800_000)
	const all = files(p.package).map((x) => x.f.slice(p.package.length + 1).replace(/\\/g, "/"))
	const want = ["fab/gerbers.zip", "fab/bom.csv", "fab/cpl.csv", "printed/case.stl", "printed/lid.stl", "assembly/exploded.png", "firmware/firmware.bin", "parts.md", "assembly.md", "bringup.md", "README.md"]
	const lacking = want.filter((f) => !all.includes(f))
	if (lacking.length) throw new Error(`the package lacks ${lacking.join(", ")}; it has: ${all.join(", ").slice(0, 900)}`)
	const clutter = all.filter((f) => /^\.|[\/]\./.test(f))
	if (clutter.length) throw new Error(`the package holds build files: ${clutter.slice(0, 5).join(", ")} (${clutter.length})`)
	if (!/scripted agents/.test(readFileSync(join(p.package, "README.md"), "utf8").split("\n").slice(0, 4).join("\n"))) throw new Error("a mock design's README doesn't open with the scripted-review banner")
	return `${all.length} files, every expected one, the scripted-review banner on top`
})
await step("Studio got the run streamed, and its command back in the run", async () => {
	if (!lastRun) throw new Error("no design ran")
	const id = basename(lastRun.outDir)
	const want = ["contract.json", "trace.jsonl", "report.md"]
	const t = Date.now()
	// The run's own end sends its last changes; it may still be closing.
	while (want.some((f) => !studio.got.get(id)?.has(f)) && Date.now() - t < 60_000) await new Promise((r) => setTimeout(r, 1000))
	const got = studio.got.get(id) ?? new Set()
	const lacking = want.filter((f) => !got.has(f))
	if (lacking.length) throw new Error(`Studio lacks ${lacking.join(", ")} of run ${id}; it got ${got.size} files from it (${[...studio.got.keys()].join(", ") || "no runs"})`)
	const leaked = [...got].filter((f) => /(^|\/)(\.pio|\.package-work|node_modules)\//.test(f))
	if (leaked.length) throw new Error(`build files went to Studio: ${leaked.slice(0, 3).join(", ")}`)
	const cmds = join(lastRun.outDir, "bench-commands.jsonl")
	if (!existsSync(cmds) || !/"cmd":"H 0 0"/.test(readFileSync(cmds, "utf8"))) throw new Error("Studio's command didn't reach the run's bench-commands.jsonl")
	return `${got.size} files of ${id}; the command written back`
})
await step("bringup-mcp logout", async () => {
	await cli("logout")
	if (existsSync(env.BRINGUP_STUDIO_TOKEN_FILE)) throw new Error("the token is still there")
	return ""
})
studio.close()
server.close()

const md = [`### ${process.platform} ${process.arch}, Node ${process.versions.node}${packed ? ", the packed package (npx bringup-mcp)" : ""}`, "", "| Step | Result | Time | Notes |", "|---|---|---|---|", ...steps.map((x) => `| ${x.name} | ${x.ok ? "pass" : "**FAIL**"} | ${x.s.toFixed(1)} s | ${x.note.replace(/\|/g, "/")} |`), ""].join("\n")
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n")
console.log(md)
process.exit(steps.every((x) => x.ok) ? 0 : 1)
