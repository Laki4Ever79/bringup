// `bringup login` (Task 3 of the Studio plan): pairs this machine with a Bringup Studio account by a device code, like
// GitHub's CLI: the CLI asks the server for a code, the person opens the URL it prints and approves, and the CLI stores
// the token it gets in ~/.bringup/studio.json (mode 0600). The token is never printed or logged.
//
// Public, in the engine: never imports src/dashboard or cloud/.
import { STUDIO } from "../brand/names.js"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// Studio's address. No public domain is settled yet (26 Nov 2026), so there is no default: a guessed domain could send
// someone's pairing to a server that isn't ours. BRINGUP_STUDIO_URL or `bringup login --url` names it.
export const STUDIO_URL: string | null = process.env.BRINGUP_STUDIO_URL ?? null

export const tokenPath = (): string => process.env.BRINGUP_STUDIO_TOKEN_FILE ?? join(homedir(), ".bringup", "studio.json")

export interface StudioToken {
	url: string
	token: string
	account: string
}

export function readToken(path = tokenPath()): StudioToken | null {
	try {
		const t = JSON.parse(readFileSync(path, "utf8")) as StudioToken
		return typeof t.url === "string" && typeof t.token === "string" && t.token ? t : null
	} catch {
		return null
	}
}

export function saveToken(t: StudioToken, path = tokenPath()): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	writeFileSync(path, JSON.stringify(t), { mode: 0o600 })
	chmodSync(path, 0o600) // a file that existed keeps its old mode through writeFileSync
}

export function logout(path = tokenPath()): boolean {
	if (!existsSync(path)) return false
	rmSync(path)
	return true
}

interface Pairing {
	deviceCode: string
	userCode: string
	verifyUrl: string
	intervalS: number
	expiresInS?: number
}

// Asks for a device code, shows where to approve it, polls until approved, denied or expired, and stores the token.
export async function login(url: string, open: (u: string) => void, opts: { fetch?: typeof fetch; path?: string; say?: (m: string) => void; sleep?: (ms: number) => Promise<void> } = {}): Promise<{ account: string }> {
	const f = opts.fetch ?? fetch
	const say = opts.say ?? ((m: string) => console.log(m))
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
	const base = url.replace(/\/+$/, "")
	const post = async (path: string, body: object) => {
		const res = await f(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) }).catch((e: unknown) => {
			throw new Error(`couldn't reach ${STUDIO} at ${base} (${e instanceof Error ? e.message : String(e)}): check the address and your connection`)
		})
		return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
	}
	const start = await post("/api/connector/pair", {})
	if (start.status !== 200) throw new Error(`${STUDIO} at ${base} didn't start a pairing (HTTP ${start.status})`)
	const p = start.body as unknown as Pairing
	say(`Open ${p.verifyUrl} and enter the code ${p.userCode} to connect this machine to ${STUDIO}.`)
	open(p.verifyUrl)
	const deadline = Date.now() + (p.expiresInS ?? 600) * 1000
	while (Date.now() < deadline) {
		await sleep(Math.max(1, p.intervalS) * 1000)
		const r = await post("/api/connector/pair/poll", { deviceCode: p.deviceCode })
		if (r.status === 200 && typeof r.body.token === "string") {
			saveToken({ url: base, token: r.body.token, account: String(r.body.account ?? "") }, opts.path)
			return { account: String(r.body.account ?? "") }
		}
		if (r.status === 202 || r.body.pending) continue
		throw new Error(`${STUDIO} refused the pairing: ${String(r.body.error ?? `HTTP ${r.status}`)}`)
	}
	throw new Error("the pairing code expired before it was approved: run `bringup login` again")
}

// Opens the approval page in the person's browser when one can be found (xdg-open, open, start); otherwise the printed
// URL is enough. Best effort: never throws.
export function openInBrowser(url: string): void {
	const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url]
	try {
		spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref()
	} catch {
		// no opener: the URL was printed
	}
}
