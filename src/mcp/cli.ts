import { fileURLToPath } from "node:url"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { startRunProcess, type RunProcess } from "../runner/spawn-run.ts"
import { createBringupMcpServer } from "./server.ts"

// stdout carries the MCP protocol, so our own logging goes to stderr. Runs are child processes with
// captured output (startRunProcess), so nothing they print reaches stdout either.
console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args)

// Runs land in the repo's out/ whatever directory the client launches us from.
const outRoot = process.env.BRINGUP_OUT ?? fileURLToPath(new URL("../../out", import.meta.url))

// Runs die with the server, so closing the client leaves no orphaned tsx processes behind.
const live = new Set<RunProcess>()
const launch = (args: Parameters<typeof startRunProcess>[0]) => {
	const run = startRunProcess(args)
	live.add(run)
	void run.done.then(() => live.delete(run))
	return run
}
const shutdown = () => {
	for (const run of live) run.kill()
	process.exit(0)
}

const server = createBringupMcpServer({ launch, outRoot })
const transport = new StdioServerTransport()
transport.onclose = shutdown
process.stdin.on("end", shutdown)
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, shutdown)
await server.connect(transport)
console.error(`bringup mcp: runs in ${outRoot}`)
