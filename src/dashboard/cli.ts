import { randomBytes } from "node:crypto"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { networkInterfaces, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { startRunProcess } from "../runner/spawn-run.ts"
import { notifierFromEnv, type TraceNotifier } from "./notify.ts"
import { preparePublicRoot, PublicGate } from "./public.ts"
import { listenWithFallback, serveDashboard, serveHub } from "./server.ts"

// npx tsx src/dashboard/cli.ts                 the hub over out/: start runs, reopen old ones
// npx tsx src/dashboard/cli.ts out/<runId>     the same hub, opened on that run
// --lan                                        also listen on the network, for a phone's Approve/Reject (see notify.ts)
// --public                                     the public demo (public.ts): read-only recorded runs + Try it, on $PORT
const args = process.argv.slice(2)
if (args.includes("--public")) {
	// No keys on a public server, whatever the host's environment holds: Try it runs are scripted (--mock) anyway.
	for (const k of Object.keys(process.env)) if (/_API_KEY$|^ANTHROPIC_BASE_URL$|^WOKWI_CLI_TOKEN$|^BRINGUP_NTFY_/.test(k)) delete process.env[k]
	process.env.MOZAIK_CREDENTIALS_FILE = "/dev/null"
	const outRoot = mkdtempSync(join(tmpdir(), "bringup-public-"))
	const runs = preparePublicRoot(outRoot)
	const briefPath = fileURLToPath(new URL("../../briefs/beacon.md", import.meta.url))
	const dash = await serveHub({ outRoot, port: Number(process.env.PORT ?? 4317), launch: startRunProcess, public: { gate: new PublicGate(), briefPath } })
	console.log(`public demo: ${dash.url.replace("127.0.0.1", "0.0.0.0")} serving ${runs.length} recorded runs (${runs.join(", ")}) from ${outRoot}`)
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.on(signal, () => void dash.close().then(() => (rmSync(outRoot, { recursive: true, force: true }), process.exit(0))))
	}
	await new Promise(() => {})
}
const lan = args.includes("--lan")
const [runDir, port] = args.filter((a) => a !== "--lan" && a !== "--public")
if (runDir && !existsSync(runDir)) {
	console.error("usage: tsx src/dashboard/cli.ts [out/<runId>] [port] [--lan]")
	process.exit(1)
}
const launch = startRunProcess
const outRoot = fileURLToPath(new URL("../../out", import.meta.url))
const token = randomBytes(24).toString("base64url")
// The ntfy push (BRINGUP_NTFY_TOPIC) is made once the port is known; until then there is nothing to push.
let push: TraceNotifier | null = null
const extra = { lan: lan ? { token } : undefined, notify: process.env.BRINGUP_NTFY_TOPIC ? (runId: string, line: string) => push?.(runId, line) ?? Promise.resolve() : undefined }
const dash = await listenWithFallback((p) => (runDir ? serveDashboard(runDir, p, launch, extra) : serveHub({ outRoot, port: p, launch, ...extra })), port ? Number(port) : 4317, (l) => console.log(l))
console.log(`dashboard: ${dash.url}`)
const lanIp = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address
const hubUrl = process.env.BRINGUP_HUB_URL ?? (lan && lanIp ? `http://${lanIp}:${new URL(dash.url).port}` : dash.url)
if (lan) console.log(`dashboard: decisions from the LAN at ${hubUrl}, with X-Bringup-Token: ${token}`)
push = notifierFromEnv(process.env, { hubUrl, token })
if (push) console.log(`dashboard: held changes go to ntfy topic ${process.env.BRINGUP_NTFY_TOPIC}${lan ? "" : " (add --lan so the phone's buttons can reach this hub)"}`)
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => void dash.close().then(() => process.exit(0)))
}
