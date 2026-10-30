import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { startRunProcess } from "../runner/spawn-run.ts"
import { serveDashboard, serveHub } from "./server.ts"

// npx tsx src/dashboard/cli.ts                 the hub over out/: start runs, reopen old ones
// npx tsx src/dashboard/cli.ts out/<runId>     the same hub, opened on that run
const [runDir, port] = process.argv.slice(2)
if (runDir && !existsSync(runDir)) {
	console.error("usage: tsx src/dashboard/cli.ts [out/<runId>] [port]")
	process.exit(1)
}
const launch = startRunProcess
const outRoot = fileURLToPath(new URL("../../out", import.meta.url))
const dash = runDir ? await serveDashboard(runDir, port ? Number(port) : undefined, launch) : await serveHub({ outRoot, port: port ? Number(port) : undefined, launch })
console.log(`dashboard: ${dash.url}`)
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => void dash.close().then(() => process.exit(0)))
}
