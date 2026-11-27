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
import { BIN, VENV, bringupHome } from "../tools/env.ts"
import { QEMU_BINS } from "../tools/qemu.ts"

export type Domain = "board" | "case" | "firmware" | "sim"
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
	// MuJoCo's wheel and Espressif's QEMU for this OS (the two machines: riscv32 for the ESP32-C3, xtensa for the ESP32 and
	// S3): a robot's firmware runs in QEMU, driving its MuJoCo model over a course (src/tools/drive.ts). Sizes: the
	// release's tarballs (Linux 32 MB, macOS 8 MB, Windows 74 MB) and MuJoCo's wheel; an ESTIMATE, not measured clean.
	sim: { what: "MuJoCo 3.17 and Espressif's QEMU 9.2.2, pinned (a robot's firmware driving its physics model)", sizeMb: 180, seconds: 40, gives: "a robot's drive proven in simulation: its own firmware in QEMU driving the MuJoCo model", needs: "QEMU's system libraries: on Linux `sudo apt install libsdl2-2.0-0 libpixman-1-0 libgcrypt20 libglib2.0-0` (libslirp comes with setup), on macOS `brew install libgcrypt glib pixman sdl2 libslirp`" },
	firmware: { what: "PlatformIO 6.2, pinned (the firmware's build tool; installing it takes seconds). The first firmware build then downloads the chip's platform and compiler, about 1 GB more (an estimate), which made that first build take 2.5-3 min on GitHub's runners", sizeMb: 125, seconds: 15, gives: "firmware built against the board's real pin map" },
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
	"x86_64-pc-windows-msvc": "297b3881fe1adfb922becc2c1613202abb41dc83ea5ff43d472aa087ca1f8683",
	"aarch64-pc-windows-msvc": "f223bcd3fa010174ffeeb885cc1d5334bb81388640c65baa5b8b42b47017337e",
}
const uvTarget = (): string | null => {
	const arch = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : null
	const os = process.platform === "linux" ? "unknown-linux-gnu" : process.platform === "darwin" ? "apple-darwin" : process.platform === "win32" ? "pc-windows-msvc" : null
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
		// npm is npm.cmd on Windows, which only starts through the shell.
		const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ["ignore", "inherit", "inherit"], shell: process.platform === "win32" && cmd === "npm" })
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
	// Windows: a .zip with uv.exe at its top (Windows 10's own tar.exe unpacks it); elsewhere a .tar.gz with a folder.
	const win = target.endsWith("windows-msvc")
	const bin = join(dir, win ? "uv.exe" : "uv")
	if (existsSync(bin)) return bin
	mkdirSync(dir, { recursive: true })
	d.log(`uv ${UV_VERSION}: downloading`)
	const res = await d.fetch(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${target}.${win ? "zip" : "tar.gz"}`)
	if (!res.ok) throw new Error(`uv download failed (HTTP ${res.status})`)
	const tar = Buffer.from(await res.arrayBuffer())
	const sum = createHash("sha256").update(tar).digest("hex")
	if (sum !== UV_SHA256[target]) throw new Error(`uv download's checksum is ${sum}, not the pinned ${UV_SHA256[target]}: not installed`)
	const archive = join(dir, win ? "uv.zip" : "uv.tar.gz")
	writeFileSync(archive, tar)
	if ((await d.exec("tar", win ? ["xf", archive, "-C", dir] : ["xzf", archive, "-C", dir, "--strip-components=1"])) !== 0) throw new Error("couldn't unpack uv")
	rmSync(archive)
	if (!win) chmodSync(bin, 0o755)
	return bin
}

// Espressif's QEMU, one release for every OS, each tarball checked against the release's own checksum file.
const QEMU_TAG = "esp-develop-9.2.2-20260417"
const QEMU_SHA256: Record<string, string> = {
	"riscv32-x86_64-linux-gnu": "547f03e04701a92cbb699f7f7d015adc1f5b5ef93cbb94c0dd9b7107e2d84e77",
	"xtensa-x86_64-linux-gnu": "0eecb2a34a5586c0e59110f77b9343b7b336e82fdb0e1a30e1dc1bab8a547e35",
	"riscv32-aarch64-apple-darwin": "67bff66ff7158f272ce167fc211c0f8f4c1a79b6f6174350678a6d5035644b30",
	"xtensa-aarch64-apple-darwin": "bb8c15810565d3df1665dc34962430885e11bc95575b228fb44698146be1e9d6",
	"riscv32-x86_64-apple-darwin": "a47c38c6e2eb9f5028eda9585dce999ce02b8983a2cdf71c48cfb10a14ae25fe",
	"xtensa-x86_64-apple-darwin": "ae8170fe46bcdfa54a7c0d7afcdb7a066711991be680f72ff7bbc6c4ae3ad88f",
	"riscv32-x86_64-w64-mingw32": "697aa4800a1f52be0b1693b30e22a684f7ea93c46c489e619384cae7b0e9b87b",
	"xtensa-x86_64-w64-mingw32": "3c483d77f5350a568df1faf4d8dbc82c95d6bc2b826d0d4be910485e0a68ca2a",
}
const qemuHost = (): string | null => {
	if (process.platform === "linux" && process.arch === "x64") return "x86_64-linux-gnu"
	if (process.platform === "darwin") return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
	if (process.platform === "win32" && process.arch === "x64") return "x86_64-w64-mingw32"
	return null
}
// Linux's QEMU links libslirp, which a desktop rarely has: Ubuntu 24.04's build (the one tested), from its .deb.
const SLIRP_DEB = "http://archive.ubuntu.com/ubuntu/pool/main/libs/libslirp/libslirp0_4.7.0-1ubuntu3.1_amd64.deb"
const SLIRP_DEB_SHA256 = "4efa2d1c509de4d10fe965e86a3d864bf542996caf476d9111fd882c73857164"

async function fetchChecked(url: string, sha: string, d: Required<InstallDeps>): Promise<Buffer> {
	const res = await d.fetch(url)
	if (!res.ok) throw new Error(`download failed (HTTP ${res.status}): ${url}`)
	const b = Buffer.from(await res.arrayBuffer())
	const sum = createHash("sha256").update(b).digest("hex")
	if (sum !== sha) throw new Error(`${url.split("/").pop()}'s checksum is ${sum}, not the pinned ${sha}: not installed`)
	return b
}

async function installQemu(home: string, d: Required<InstallDeps>): Promise<void> {
	const host = qemuHost()
	if (!host) throw new Error(`Espressif has no QEMU build for ${process.platform}-${process.arch}`)
	const tools = join(home, "tools")
	mkdirSync(tools, { recursive: true })
	for (const arch of ["riscv32", "xtensa"]) {
		if (existsSync(join(home, QEMU_BINS[arch as "riscv32" | "xtensa"]))) continue
		const name = `qemu-${arch}-softmmu-esp_develop_9.2.2_20260417-${host}.tar.xz`
		d.log(`sim: QEMU ${arch} (${name})`)
		const archive = join(tools, name)
		writeFileSync(archive, await fetchChecked(`https://github.com/espressif/qemu/releases/download/${QEMU_TAG}/${name}`, QEMU_SHA256[`${arch}-${host}`], d))
		// Each unpacks to qemu/ (bin/, share/); Windows 10's tar.exe reads .tar.xz too.
		const code = await d.exec("tar", ["xf", archive, "-C", tools])
		rmSync(archive)
		if (code !== 0) throw new Error(`couldn't unpack ${name}`)
	}
	if (process.platform === "linux" && !existsSync(join(tools, "qemu", "lib", "libslirp.so.0"))) {
		// The .deb's data, without dpkg or root: ar and tar, as `dpkg -x` does.
		const tmp = join(tools, "slirp-tmp")
		mkdirSync(tmp, { recursive: true })
		writeFileSync(join(tmp, "s.deb"), await fetchChecked(SLIRP_DEB, SLIRP_DEB_SHA256, d))
		const unpacked = (await d.exec("dpkg-deb", ["-x", "s.deb", "."], { cwd: tmp })) === 0 || ((await d.exec("ar", ["x", "s.deb"], { cwd: tmp })) === 0 && (await d.exec("tar", ["xf", "data.tar.zst"], { cwd: tmp })) === 0)
		const lib = join(tmp, "usr", "lib", "x86_64-linux-gnu")
		if (!unpacked || !existsSync(lib)) {
			rmSync(tmp, { recursive: true, force: true })
			throw new Error("couldn't unpack libslirp's .deb: it needs dpkg-deb, or ar and a tar that reads zstd")
		}
		mkdirSync(join(tools, "qemu", "lib"), { recursive: true })
		for (const f of readdirSync(lib).filter((f) => f.startsWith("libslirp.so.0"))) copyFileSync(join(lib, f), join(tools, "qemu", "lib", f))
		rmSync(tmp, { recursive: true, force: true })
	}
}

// Installs one domain into the tools home. Idempotent: an installed domain is left as it is.
export async function installDomain(domain: Domain, deps: InstallDeps = {}): Promise<{ installed: boolean; note: string }> {
	const d: Required<InstallDeps> = { home: deps.home ?? bringupHome(), log: deps.log ?? ((m) => console.error(m)), exec: deps.exec ?? execDefault, fetch: deps.fetch ?? fetch }
	const home = d.home
	if (domain === "board") {
		const dir = join(home, "tools", "node")
		if (existsSync(join(dir, "node_modules", ".bin", BIN.tsci))) return { installed: false, note: "board tools already installed" }
		mkdirSync(dir, { recursive: true })
		// The tested lockfile (src/setup/tools-node): its dependencies don't float.
		for (const f of ["package.json", "package-lock.json"]) copyFileSync(join(ROOT, "src", "setup", "tools-node", f), join(dir, f))
		d.log(`board: ${DOMAINS.board.what} into ${dir}`)
		// In the tools folder itself, not --prefix: macOS's npm read the folder's package.json and lock out of step through
		// --prefix ("Missing: node@ from lock file", OS smoke run 2), though the same lock installs cleanly here.
		const code = await d.exec("npm", ["ci", "--no-audit", "--no-fund"], { cwd: dir })
		if (code !== 0 || !existsSync(join(dir, "node_modules", ".bin", BIN.tsci))) throw new Error(`board tools didn't install (npm ci exited ${code})`)
		return { installed: true, note: `board tools in ${dir}` }
	}
	const venv = join(home, ".venv")
	const python = join(home, VENV.python)
	const uv = await ensureUv(home, d)
	if (!existsSync(python)) {
		d.log(`python 3.12: creating ${venv}`)
		if ((await d.exec(uv, ["venv", "-q", "--python", "3.12", venv])) !== 0) throw new Error("couldn't create the Python environment")
	}
	if (domain === "sim") {
		const hasMujoco = (await d.exec(python, ["-c", "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('mujoco') else 1)"])) === 0
		const slirp = process.platform !== "linux" || existsSync(join(home, "tools", "qemu", "lib", "libslirp.so.0"))
		if (hasMujoco && slirp && existsSync(join(home, QEMU_BINS.riscv32)) && existsSync(join(home, QEMU_BINS.xtensa))) return { installed: false, note: "sim tools already installed" }
		d.log(`sim: ${DOMAINS.sim.what} into ${home}`)
		if (!hasMujoco && (await d.exec(uv, ["pip", "install", "-q", "--python", python, "mujoco==3.17.0"])) !== 0) throw new Error("MuJoCo didn't install")
		await installQemu(home, d)
		const qemu = join(home, QEMU_BINS.riscv32)
		const runs = (await d.exec(qemu, ["--version"], { env: { LD_LIBRARY_PATH: join(home, "tools", "qemu", "lib") } })) === 0
		return { installed: true, note: runs ? `sim tools in ${home}` : `sim tools installed, but QEMU doesn't start here${process.platform === "win32" ? ` (${qemu} --version failed)` : `: it needs ${DOMAINS.sim.needs}`}` }
	}
	const pkgs = domain === "case" ? ["build123d==0.13.0"] : ["platformio==6.2.0"]
	const marker = domain === "case" ? python : join(home, VENV.pio)
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

// What `setup` with no domain prints: each domain on one line, whether it's installed here, its size and time, what it
// gives, then the commands (a newcomer's read, 27 Nov 2026: three 250-character lines, no word on what was already
// installed, and "all" never explained).
const SHORT: Record<Domain, string> = {
	board: "a routed board, its fab files and pictures of it",
	case: "the case or chassis as STEP and STL, a robot's 3D pictures",
	firmware: "firmware built against the board's real pin map",
	sim: "a robot's firmware in QEMU driving its MuJoCo model",
}
export function setupListing(home = bringupHome()): string {
	const have = new Set(installedDomains(home))
	const all: Domain[] = ["board", "case", "firmware", "sim"]
	const size = (d: Domain) => (DOMAINS[d].sizeMb >= 1000 ? `~${(DOMAINS[d].sizeMb / 1000).toFixed(1)} GB` : `~${DOMAINS[d].sizeMb} MB`)
	const rows = all.map((d) => `  ${d.padEnd(9)} ${(have.has(d) ? "installed" : "not installed").padEnd(14)} ${`${size(d)}, ~${DOMAINS[d].seconds} s`.padEnd(16)} ${SHORT[d]}`)
	const missing = all.filter((d) => !have.has(d))
	return [
		`Bringup's tools, each installed once into ${home} (pinned versions, nothing system-wide):`,
		"",
		...rows,
		"           (firmware's first build then downloads the chip's compiler: ~1 GB more, 2.5-3 min, once)",
		"",
		missing.length
			? `Install:  npx bringup-mcp setup ${missing.join(" ")}${missing.length > 1 ? `      (or one at a time; "all" installs every domain)` : ""}`
			: "Everything is installed.",
		"Without a domain's tools, designs still run: those parts are stubbed and the run's summary says which command builds them.",
	].join("\n")
}

// `npx bringup-mcp setup [board|case|firmware|all]`: what each would download, then the install. With no domain it
// only lists them, so nothing is downloaded by accident.
export async function setupCli(args: string[]): Promise<number> {
	const asked = args.filter((a) => !a.startsWith("-"))
	const all: Domain[] = ["board", "case", "firmware", "sim"]
	const picked = asked.includes("all") ? all : (asked.filter((a) => all.includes(a as Domain)) as Domain[])
	const unknown = asked.filter((a) => a !== "all" && !all.includes(a as Domain))
	if (!picked.length || unknown.length) {
		console.error(`${unknown.length ? `unknown domain: ${unknown.join(", ")}\n\n` : ""}${setupListing()}`)
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
	if (existsSync(join(home, "tools", "node", "node_modules", ".bin", BIN.tsci))) out.push("board")
	const lib = join(home, ".venv", "lib")
	// Linux and macOS: .venv/lib/python3.12/site-packages; Windows: .venv/Lib/site-packages.
	const site = existsSync(lib) ? [join(lib, "site-packages"), ...readdirSync(lib).map((v) => join(lib, v, "site-packages"))] : []
	if (site.some((p) => existsSync(join(p, "build123d")))) out.push("case")
	if (existsSync(join(home, VENV.pio))) out.push("firmware")
	if (site.some((p) => existsSync(join(p, "mujoco"))) && existsSync(join(home, QEMU_BINS.riscv32))) out.push("sim")
	return out
}
