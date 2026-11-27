#!/usr/bin/env node
// `npx bringup-mcp`: Bringup's MCP server on stdio (docs/mcp.md). The sources are TypeScript, run through tsx.
// `npx bringup-mcp setup <board|case|firmware|all>`: installs one domain's tools into ~/.bringup (src/setup/domains.ts).
// `npx bringup-mcp login --url <studio>` / `logout`: connects this machine to Bringup Studio (src/connector/cli.ts).
// `npx bringup-mcp bench-stream <design folder> <device>` / `bench-log <design folder> <log>`: the real robot's serial
// log, saved in the design and read for what it shows (src/bench/cli.ts).
import { register } from "tsx/esm/api"

register()
if (process.argv[2] === "setup") {
	const { setupCli } = await import("../src/setup/domains.ts")
	process.exit(await setupCli(process.argv.slice(3)))
} else if (process.argv[2] === "login" || process.argv[2] === "logout") {
	// Connect this machine to Bringup Studio (docs/studio.md): every run, the MCP's included, then streams there.
	const { connectorCli } = await import("../src/connector/cli.ts")
	process.exit(await connectorCli(process.argv.slice(2)))
} else if (process.argv[2] === "bench-stream" || process.argv[2] === "bench-log") {
	const { benchCli } = await import("../src/bench/cli.ts")
	process.exit(await benchCli(process.argv.slice(2)))
} else await import("../src/mcp/cli.ts")
