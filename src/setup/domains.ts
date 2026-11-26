// The tools a run needs, installed one domain at a time into the tools home (~/.bringup, src/tools/env.ts bringupHome)
// on the person's yes: `npx bringup-mcp setup <domain>`, or start_design's installTools after they agreed. A git
// checkout's `npm run setup` (setup.ts) installs everything beside the repo; this is the npm install's way, and asks
// for nothing it doesn't need (setup streamlining, 26 Nov 2026: a fresh npx user got a stubbed design, no board and no
// pictures, and was told to run "npm run setup in a clone" they didn't have).
//
// Sizes and times were measured on a clean node:24-bookworm container (26 Nov 2026); they are what a person is told
// before saying yes.
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { bringupHome } from "../tools/env.ts"

export type Domain = "board" | "case" | "firmware"
export interface DomainInfo {
	what: string
	sizeMb: number
	seconds: number
	// What the domain gives a run once installed.
	gives: string
	// A system library or tool the install can't bring itself (no sudo), checked after installing.
	needs?: string
}

export const DOMAINS: Record<Domain, DomainInfo> = {
	board: { what: "tscircuit and bun, pinned (the board's generator, autorouter and pictures)", sizeMb: 923, seconds: 35, gives: "a routed board, its fab files and pictures of it" },
	case: { what: "Python 3.12 and build123d 0.13, pinned (the CAD kernel for cases, chassis and printed parts), through uv", sizeMb: 945, seconds: 75, gives: "the case or chassis as STEP and STL, and the robot's assembly pictures", needs: "the system's OpenGL library (libGL.so.1): on a desktop it's there; on a minimal Linux, `sudo apt install libgl1`" },
	// PlatformIO itself measured 122 MB with its Python, 11 s; the chip's platform and compiler it fetches on the first
	// firmware build are not counted (about 1 GB for the ESP32 family: an ESTIMATE, not measured on the clean container).
	firmware: { what: "PlatformIO 6.2, pinned (the firmware's build tool); the first firmware build then fetches the chip's platform and compiler, about 1 GB more (an estimate)", sizeMb: 125, seconds: 15, gives: "firmware built against the board's real pin map" },
}

export const describeDomain = (d: Domain): string => `${d}: about ${DOMAINS[d].sizeMb >= 1000 ? `${(DOMAINS[d].sizeMb / 1000).toFixed(1)} GB` : `${DOMAINS[d].sizeMb} MB`} and ${DOMAINS[d].seconds} s, once, for ${DOMAINS[d].what}; gives ${DOMAINS[d].gives}`

// uv, pinned by release and checksum: it brings its own Python, so the case and firmware domains need nothing from the
// system but the libraries the CAD kernel loads.
const UV_VERSION = "0.13.10"
const UV_SHA256: Record<string, string> = {
	"x86_64-unknown-linux-gnu": "bf65ac1a0af10f92c522d91ac096c7c0a39657647b155577e7836c2cbbb4526c",
	"aarch64-unknown-linux-gnu": "14590f644805a6234ffe071154340669e38137f38e60aa9629690119704107d2",
	"aarch64-apple-darwin": "e419bf07533bdbf48795fc793601c834dd79db57a8c49ce8e25cfe3a8639958d",
	"x86_64-apple-darwin": "153e03197588204c04fc4c81cc4bafbfa4280222a385e4ee36a87aeec0ae63b4",
}
const uvTarget = (): string | null => {
	const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : null
	const os = process.platform === "linux" ? "unknown-linux-gnu" : process.platform === "darwin" ? "apple-darwin" : null
	return arch && os ? `${arch}-${os}` : null
}

export interface InstallDeps {
	home?: string
	log?: (m: string) => void
	// Runs a command; resolves its exit code. Tests replace it.
	exec?: (cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string> }) => Promise<number>
	fetch?: typeof fetch
}

const ROOT = fileURLToPath(new URL("../..", import.meta.url))

function execDefault(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<number> {
	return new Promise((done) => {
		const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["ignore", "inherit", "inherit"] })
		child.on("error", () => done(-1))
		child.on("exit", (code) => done(code ?? -1))
	})
}

// The tools home's uv: one already on PATH, else the pinned release, downloaded and checked.
async function ensureUv(home: string, d: Required<InstallDeps>): Promise<string> {
	if ((await d.exec("uv", ["--version"])) === 0) return "uv"
	const target = uvTarget()
	if (!target || !UV_SHA256[target]) throw new Error(`no pinned uv for ${process.platform}-${process.arch}: install uv (https://docs.astral.sh/uv/), then run setup again`)
	const dir = join(home, "tools", "uv")
	const bin = join(dir, "uv")
	if (existsSync(bin)) return bin
	mkdirSync(dir, { recursive: true })
	d.log(`uv ${UV_VERSION}: downloading`)
	const res = await d.fetch(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${target}.tar.gz`)
	if (!res.ok) throw new Error(`uv download failed (HTTP ${res.status})`)
	const tar = Buffer.from(await res.arrayBuffer())
	const sum = createHash("sha256").update(tar).digest("hex")
	if (sum !== UV_SHA256[target]) throw new Error(`uv download's checksum is ${sum}, not the pinned ${UV_SHA256[target]}: not installed`)
	const tgz = join(dir, "uv.tar.gz")
	writeFileSync(tgz, tar)
	if ((await d.exec("tar", ["xzf", tgz, "-C", dir, "--strip-components=1"])) !== 0) throw new Error("couldn't unpack uv")
	rmSync(tgz)
	chmodSync(bin, 0o755)
	return bin
}

// Installs one domain into the tools home. Idempotent: an installed domain is left as it is.
export async function installDomain(domain: Domain, deps: InstallDeps = {}): Promise<{ installed: boolean; note: string }> {
	const d: Required<InstallDeps> = { home: deps.home ?? bringupHome(), log: deps.log ?? ((m) => console.error(m)), exec: deps.exec ?? execDefault, fetch: deps.fetch ?? fetch }
	const home = d.home
	if (domain === "board") {
		const dir = join(home, "tools", "node")
		if (existsSync(join(dir, "node_modules", ".bin", "tsci"))) return { installed: false, note: "board tools already installed" }
		mkdirSync(dir, { recursive: true })
		// The tested lockfile (src/setup/tools-node): its dependencies don't float.
		for (const f of ["package.json", "package-lock.json"]) copyFileSync(join(ROOT, "src", "setup", "tools-node", f), join(dir, f))
		d.log(`board: ${DOMAINS.board.what} into ${dir}`)
		const code = await d.exec("npm", ["ci", "--no-audit", "--no-fund", "--prefix", dir])
		if (code !== 0 || !existsSync(join(dir, "node_modules", ".bin", "tsci"))) throw new Error(`board tools didn't install (npm ci exited ${code})`)
		return { installed: true, note: `board tools in ${dir}` }
	}
	const venv = join(home, ".venv")
	const python = join(venv, "bin", "python")
	const uv = await ensureUv(home, d)
	if (!existsSync(python)) {
		d.log(`python 3.12: creating ${venv}`)
		if ((await d.exec(uv, ["venv", "-q", "--python", "3.12", venv])) !== 0) throw new Error("couldn't create the Python environment")
	}
	const pkgs = domain === "case" ? ["build123d==0.13.0"] : ["platformio==6.2.0"]
	const marker = domain === "case" ? join(venv, "bin", "python") : join(venv, "bin", "pio")
	if (domain === "firmware" && existsSync(marker)) return { installed: false, note: "firmware tools already installed" }
	if (domain === "case" && (await d.exec(python, ["-c", "import build123d"])) === 0) return { installed: false, note: "case tools already installed" }
	d.log(`${domain}: ${DOMAINS[domain].what} into ${venv}`)
	if ((await d.exec(uv, ["pip", "install", "-q", "--python", python, ...pkgs])) !== 0) throw new Error(`${domain} tools didn't install`)
	if (domain === "case" && (await d.exec(python, ["-c", "import build123d"])) !== 0) {
		// Installed, but the CAD kernel can't load: almost always the system's libGL (a minimal Linux has none).
		return { installed: true, note: `case tools installed, but the CAD kernel can't load here: it needs ${DOMAINS.case.needs}` }
	}
	return { installed: true, note: `${domain} tools in ${venv}` }
}

// `npx bringup-mcp setup [board|case|firmware|all]`: what each would download, then the install. With no domain it
// only lists them, so nothing is downloaded by accident.
export async function setupCli(args: string[]): Promise<number> {
	const asked = args.filter((a) => !a.startsWith("-"))
	const all: Domain[] = ["board", "case", "firmware"]
	const picked = asked.includes("all") ? all : (asked.filter((a) => all.includes(a as Domain)) as Domain[])
	const unknown = asked.filter((a) => a !== "all" && !all.includes(a as Domain))
	if (!picked.length || unknown.length) {
		console.error(`${unknown.length ? `unknown domain: ${unknown.join(", ")}\n` : ""}usage: npx bringup-mcp setup <board|case|firmware|all>\n\nEach installs once into ${bringupHome()}:\n${all.map((x) => `  ${describeDomain(x)}`).join("\n")}`)
		return unknown.length ? 2 : 0
	}
	let failed = false
	for (const dm of picked) {
		const t = Date.now()
		try {
			const r = await installDomain(dm)
			console.error(`${dm}: ${r.note}${r.installed ? ` (${Math.round((Date.now() - t) / 1000)} s)` : ""}`)
		} catch (e) {
			failed = true
			console.error(`${dm}: ${(e as Error).message}`)
		}
	}
	return failed ? 1 : 0
}

// For tests and doctor: the domains installed in a tools home.
export function installedDomains(home = bringupHome()): Domain[] {
	const out: Domain[] = []
	if (existsSync(join(home, "tools", "node", "node_modules", ".bin", "tsci"))) out.push("board")
	const lib = join(home, ".venv", "lib")
	const site = existsSync(lib) ? readdirSync(lib).map((v) => join(lib, v, "site-packages")) : []
	if (site.some((p) => existsSync(join(p, "build123d")))) out.push("case")
	if (existsSync(join(home, ".venv", "bin", "pio"))) out.push("firmware")
	return out
}
