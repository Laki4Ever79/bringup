import { fileURLToPath } from "node:url"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { runDesign } from "../run.ts"
import { createBringupMcpServer } from "./server.ts"

// stdout carries the MCP protocol. Anything else that prints there (Mozaik prints a Cloud link per
// runLoop) would corrupt it, so plain logging goes to stderr.
console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args)

// Runs land in the repo's out/ whatever directory the client launches us from.
const outRoot = process.env.BRINGUP_OUT ?? fileURLToPath(new URL("../../out", import.meta.url))
const server = createBringupMcpServer({ runDesign, outRoot })
await server.connect(new StdioServerTransport())
console.error(`bringup mcp: runs in ${outRoot}`)
