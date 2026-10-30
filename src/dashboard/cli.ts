import { existsSync } from "node:fs"
import { serveDashboard } from "./server.ts"

// npx tsx src/dashboard/cli.ts out/<runId> [port]
const [runDir, port] = process.argv.slice(2)
if (!runDir || !existsSync(runDir)) {
	console.error("usage: tsx src/dashboard/cli.ts out/<runId> [port]")
	process.exit(1)
}
const dash = await serveDashboard(runDir, port ? Number(port) : undefined)
console.log(`dashboard: ${dash.url}`)
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => void dash.close().then(() => process.exit(0)))
}
