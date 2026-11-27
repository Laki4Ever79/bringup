// `npx bringup-mcp add <client>` (src/setup/clients.ts): each client's config file per OS, the entry merged beside the
// servers already there, the old file kept as .bak, a file with comments left alone, the same entry twice changes nothing.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { addClient, configPath, entry, isolatedClientEnv, snippet } from "../src/setup/clients.ts"
import { tempDir } from "./helpers.ts"

test("each client's user config, per OS", () => {
	const env = { HOME: "/h", USERPROFILE: "C:\\Users\\u", APPDATA: "C:\\Users\\u\\AppData\\Roaming" }
	assert.equal(configPath("claude-desktop", "darwin", env).path, join("/h", "Library", "Application Support", "Claude", "claude_desktop_config.json"))
	assert.equal(configPath("claude-desktop", "win32", env).path, join(env.APPDATA, "Claude", "claude_desktop_config.json"))
	assert.equal(configPath("vscode", "linux", env).path, join("/h", ".config", "Code", "User", "mcp.json"))
	assert.equal(configPath("vscode", "linux", env).key, "servers")
	assert.equal(configPath("cursor", "darwin", env).path, join("/h", ".cursor", "mcp.json"))
	assert.equal(configPath("windsurf", "linux", env).path, join("/h", ".codeium", "windsurf", "mcp_config.json"))
	// Windows: through cmd, VS Code too.
	assert.deepEqual(entry("cursor", "win32"), { command: "cmd", args: ["/c", "npx", "-y", "bringup-mcp"] })
	assert.deepEqual(entry("vscode", "win32"), { type: "stdio", command: "cmd", args: ["/c", "npx", "-y", "bringup-mcp"] })
	assert.deepEqual(JSON.parse(snippet("windsurf", "linux")), { mcpServers: { bringup: { command: "npx", args: ["-y", "bringup-mcp"] } } })
})

test("add: merged beside the other servers, the old file kept, twice is once, comments left alone", () => {
	const home = tempDir()
	const env = isolatedClientEnv(home)
	// A config that doesn't exist yet is made.
	const fresh = addClient("windsurf", { platform: "linux", env })
	assert.equal(fresh.written, true)
	assert.deepEqual(JSON.parse(readFileSync(fresh.path!, "utf8")).mcpServers.bringup, { command: "npx", args: ["-y", "bringup-mcp"] })
	assert.ok(!existsSync(`${fresh.path}.bak`))
	// One with other servers and settings keeps them, and its old text is saved.
	const { path } = configPath("claude-desktop", "linux", env)
	mkdirSync(join(path, ".."), { recursive: true })
	const before = JSON.stringify({ globalShortcut: "Ctrl+Space", mcpServers: { other: { command: "other-mcp" } } })
	writeFileSync(path, before)
	const r = addClient("claude-desktop", { platform: "linux", env })
	assert.equal(r.written, true)
	const after = JSON.parse(readFileSync(path, "utf8"))
	assert.equal(after.globalShortcut, "Ctrl+Space")
	assert.deepEqual(Object.keys(after.mcpServers), ["other", "bringup"])
	assert.equal(readFileSync(`${path}.bak`, "utf8"), before)
	assert.match(r.message, /\.bak/)
	// The same entry again: nothing written.
	assert.equal(addClient("claude-desktop", { platform: "linux", env }).written, false)
	// VS Code's mcp.json with a comment: not plain JSON, so untouched; the snippet is printed.
	const vs = configPath("vscode", "linux", env).path
	mkdirSync(join(vs, ".."), { recursive: true })
	writeFileSync(vs, '{\n  // mine\n  "servers": {}\n}\n')
	const c = addClient("vscode", { platform: "linux", env })
	assert.equal(c.written, false)
	assert.equal(readFileSync(vs, "utf8"), '{\n  // mine\n  "servers": {}\n}\n')
	assert.match(c.message, /"servers"[\s\S]*"bringup"[\s\S]*"type": "stdio"/)
	// --print only shows; Claude Code gets its own command.
	assert.equal(addClient("cursor", { platform: "linux", env, printOnly: true }).written, false)
	assert.ok(!existsSync(configPath("cursor", "linux", env).path))
	assert.match(addClient("claude-code").message, /claude mcp add bringup -- npx -y bringup-mcp/)
})

test("the sandbox: every client's config inside the isolated env's dir on every OS; a path outside it is refused, nothing written", () => {
	const home = tempDir()
	const env = isolatedClientEnv(home)
	for (const platform of ["linux", "darwin", "win32"] as const)
		for (const client of ["claude-desktop", "cursor", "vscode", "windsurf"] as const)
			assert.ok(configPath(client, platform, env).path.startsWith(home), `${client} on ${platform}: ${configPath(client, platform, env).path}`)
	// The env that caused it: HOME in the sandbox, XDG_CONFIG_HOME still the real one.
	const leaky = { ...env, XDG_CONFIG_HOME: join(tempDir(), "real-config") }
	assert.throws(() => addClient("vscode", { platform: "linux", env: leaky }), /outside BRINGUP_CONFIG_SANDBOX/)
	assert.ok(!existsSync(join(leaky.XDG_CONFIG_HOME, "Code")))
})
