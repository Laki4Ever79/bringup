#!/usr/bin/env node
// `npx bringup-mcp`: Bringup's MCP server on stdio (docs/mcp.md). The sources are TypeScript, run through tsx.
import { register } from "tsx/esm/api"

register()
await import("../src/mcp/cli.ts")
