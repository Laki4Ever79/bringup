import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { startRunProcess, type RunProcess } from "../runner/spawn-run.ts"
import { createBringupMcpServer } from "./server.ts"

// stdout carries the MCP protocol, so our own logging goes to stderr. Runs are child processes with
// captured output (startRunProcess), so nothing they print reaches stdout either.
console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args)

// Runs land in a git checkout's out/ whatever directory the client launches us from; an npm install (npx bringup-mcp)
// lives in npm's cache, so its runs go to ~/.bringup/runs. BRINGUP_OUT overrides both.
const root = fileURLToPath(new URL("../..", import.meta.url))
const outRoot = process.env.BRINGUP_OUT ?? (existsSync(join(root, ".git")) ? join(root, "out") : join(homedir(), ".bringup", "runs"))
mkdirSync(outRoot, { recursive: true })

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
