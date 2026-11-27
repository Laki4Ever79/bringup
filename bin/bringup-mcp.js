#!/usr/bin/env node
// `npx bringup-mcp`: Bringup's MCP server on stdio (docs/mcp.md). The sources are TypeScript, run through tsx.
// `npx bringup-mcp setup <board|case|firmware|sim|all>`: installs one domain's tools into ~/.bringup (src/setup/domains.ts).
// `npx bringup-mcp login --url <studio>` / `logout`: connects this machine to Bringup Studio (src/connector/cli.ts).
// `npx bringup-mcp bench-stream <design folder> <device>` / `bench-log <design folder> <log>`: the real robot's serial
// log, saved in the design and read for what it shows (src/bench/cli.ts).
import { register } from "tsx/esm/api"

register()
if (["--help", "-h", "help"].includes(process.argv[2])) {
	// A person typing it, not an MCP client (which starts it with no arguments): without this it started the server and
	// waited silently on stdin.
	console.log(`bringup-mcp: Bringup for Claude Code and other MCP clients.

  npx bringup-mcp                      the MCP server on stdio (add it: claude mcp add bringup -- npx -y bringup-mcp)
  npx bringup-mcp setup [domain...]    list the hardware tools, or install board, case, firmware, sim or all
  npx bringup-mcp login --url <studio> connect this machine to Bringup Studio; logout disconnects
  npx bringup-mcp bench-log <design> <log>   read a real board's serial log into its design

Docs: https://github.com/Laki4Ever79/bringup/blob/main/docs/mcp.md`)
	process.exit(0)
} else if (process.argv[2] === "setup") {
	const { setupCli } = await import("../src/setup/domains.ts")
	process.exit(await setupCli(process.argv.slice(3)))
} else if (process.argv[2] === "login" || process.argv[2] === "logout") {
	// Connect this machine to Bringup Studio (docs/studio.md): every run, the MCP's included, then streams there.
	const { connectorCli } = await import("../src/connector/cli.ts")
	process.exit(await connectorCli(process.argv.slice(2)))
} else if (process.argv[2] === "bench-stream" || process.argv[2] === "bench-send" || process.argv[2] === "bench-log") {
	const { benchCli } = await import("../src/bench/cli.ts")
	process.exit(await benchCli(process.argv.slice(2)))
} else await import("../src/mcp/cli.ts")
