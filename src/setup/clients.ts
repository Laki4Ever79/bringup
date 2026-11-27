// `npx bringup-mcp add <client>`: Bringup's MCP server in another client's config (Claude Desktop, Cursor, VS Code,
// Windsurf), the way that client reads it. Claude Code has its own command (`claude mcp add`), printed rather than
// written. The entry is merged into the client's user config: other servers are kept, the old file is saved beside it
// as .bak, and a file that isn't plain JSON (VS Code allows comments) is left alone, the snippet printed instead.
//
// Public, in the engine.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const CLIENTS = ["claude-desktop", "cursor", "vscode", "windsurf", "claude-code"] as const
export type Client = (typeof CLIENTS)[number]

export const SERVER_NAME = "bringup"

// The command a client starts. Windows: through cmd, since a client that starts programs without a shell can't start
// npx (npx.cmd there) directly; VS Code starts npx itself.
export function entry(client: Client, platform: NodeJS.Platform = process.platform): Record<string, unknown> {
	const win = platform === "win32" && client !== "vscode"
	const run = win ? { command: "cmd", args: ["/c", "npx", "-y", "bringup-mcp"] } : { command: "npx", args: ["-y", "bringup-mcp"] }
	return client === "vscode" ? { type: "stdio", ...run } : run
}

// Each client's user config file and the key its servers sit under. env: HOME, USERPROFILE and APPDATA as the OS gives
// them (tests point them at a temp folder).
export function configPath(client: Exclude<Client, "claude-code">, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): { path: string; key: "mcpServers" | "servers" } {
	const home = (platform === "win32" ? env.USERPROFILE : env.HOME) || homedir()
	const appData = env.APPDATA || join(home, "AppData", "Roaming")
	const support = join(home, "Library", "Application Support")
	const config = env.XDG_CONFIG_HOME || join(home, ".config")
	switch (client) {
		case "claude-desktop":
			// Linux: Anthropic ships no Claude Desktop; community builds read ~/.config/Claude.
			return { path: join(platform === "darwin" ? support : platform === "win32" ? appData : config, "Claude", "claude_desktop_config.json"), key: "mcpServers" }
		case "vscode":
			return { path: join(platform === "darwin" ? support : platform === "win32" ? appData : config, "Code", "User", "mcp.json"), key: "servers" }
		case "cursor":
			return { path: join(home, ".cursor", "mcp.json"), key: "mcpServers" }
		case "windsurf":
			return { path: join(home, ".codeium", "windsurf", "mcp_config.json"), key: "mcpServers" }
	}
}

// The snippet as the client's file would hold it (for the docs and for a file that can't be merged).
export function snippet(client: Exclude<Client, "claude-code">, platform: NodeJS.Platform = process.platform): string {
	return JSON.stringify({ [configPath(client, platform).key]: { [SERVER_NAME]: entry(client, platform) } }, null, 2)
}

export interface AddResult {
	written: boolean
	path?: string
	message: string
}

export function addClient(client: Client, opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; printOnly?: boolean } = {}): AddResult {
	const platform = opts.platform ?? process.platform
	if (client === "claude-code") return { written: false, message: "Claude Code adds servers itself:\n\n  claude mcp add bringup -- npx -y bringup-mcp\n" }
	const { path, key } = configPath(client, platform, opts.env ?? process.env)
	const show = `${path}:\n\n${snippet(client, platform)}\n`
	if (opts.printOnly) return { written: false, path, message: `Add this to ${show}` }
	let config: Record<string, unknown> = {}
	if (existsSync(path)) {
		const text = readFileSync(path, "utf8")
		try {
			config = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {}
			if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("not an object")
		} catch {
			return { written: false, path, message: `${path} isn't plain JSON (comments?), so it was left as it is. Add this to it by hand:\n\n${snippet(client, platform)}\n` }
		}
	}
	const servers = (config[key] && typeof config[key] === "object" ? config[key] : {}) as Record<string, unknown>
	const want = entry(client, platform)
	if (JSON.stringify(servers[SERVER_NAME]) === JSON.stringify(want)) return { written: false, path, message: `${client}: Bringup is already in ${path}` }
	const replaced = SERVER_NAME in servers
	const backedUp = existsSync(path)
	if (backedUp) copyFileSync(path, `${path}.bak`)
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, JSON.stringify({ ...config, [key]: { ...servers, [SERVER_NAME]: want } }, null, 2) + "\n")
	return { written: true, path, message: `${client}: Bringup ${replaced ? "updated" : "added"} in ${path}${backedUp ? ` (the previous file is ${path}.bak)` : ""}; restart ${client === "vscode" ? "VS Code's MCP servers (MCP: List Servers)" : "the app"} to load it` }
}

// argv after "add": a client and --print.
export function addCli(argv: string[], say: { out: (m: string) => void; err: (m: string) => void } = { out: (m) => console.log(m), err: (m) => console.error(m) }): number {
	const client = argv.find((a) => !a.startsWith("-"))
	if (!client || !(CLIENTS as readonly string[]).includes(client)) {
		say.err(`usage: npx bringup-mcp add <${CLIENTS.join("|")}> [--print]\n  writes Bringup's MCP server into that client's config (the old file kept as .bak); --print only shows it`)
		return client ? 2 : 0
	}
	const r = addClient(client as Client, { printOnly: argv.includes("--print") })
	say.out(r.message)
	return 0
}
