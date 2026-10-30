import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { getgid, getuid } from "node:process"
import { join } from "node:path"
import { parseKicadSymbols, type KicadSymbol } from "../contract/grounding.ts"
import { KICAD_IMAGE, type Env } from "./env.ts"
import { run } from "./exec.ts"

const SYMBOL_DIR = "/usr/share/kicad/symbols"
const TIMEOUT_MS = 60_000
const STDERR_TAIL_LINES = 40

// Raw library text from the local KiCad install or the Docker image. Like kicadCli, but running cat.
async function readLibrary(env: Env, library: string): Promise<string> {
	const path = `${SYMBOL_DIR}/${library}.kicad_sym`
	if (env.kicad === "local") return readFile(path, "utf8")
	if (env.kicad !== "docker") throw new Error("KiCad is not available (no kicad-cli and no kicad/kicad:10.0 image)")
	const user = `${getuid?.() ?? 1000}:${getgid?.() ?? 1000}`
	const r = await run("docker", ["run", "--rm", "-u", user, KICAD_IMAGE, "cat", path], { timeoutMs: TIMEOUT_MS })
	if (r.code !== 0) throw new Error(`reading KiCad library ${library} failed: ${r.stderr.trimEnd().split("\n").slice(-STDERR_TAIL_LINES).join("\n")}`)
	return r.stdout
}

// Parsed symbols from the named KiCad libraries (e.g. "Sensor_Humidity"), merged; the first library wins on a name
// clash. Each library is parsed once and cached as JSON under out/.cache/kicad-symbols/.
export async function loadSymbols(env: Env, libraries: string[]): Promise<Record<string, KicadSymbol>> {
	const cacheDir = join(env.root, "out/.cache/kicad-symbols")
	await mkdir(cacheDir, { recursive: true })
	const parsed = await Promise.all(
		libraries.map(async (library) => {
			if (!/^[\w+-]+$/.test(library)) throw new Error(`not a KiCad library name: ${library}`)
			const cached = join(cacheDir, `${library}.json`)
			if (existsSync(cached)) return JSON.parse(await readFile(cached, "utf8")) as Record<string, KicadSymbol>
			const symbols = parseKicadSymbols(await readLibrary(env, library))
			if (Object.keys(symbols).length === 0) throw new Error(`KiCad library ${library} has no symbols`)
			await writeFile(cached, JSON.stringify(symbols))
			return symbols
		}),
	)
	const merged: Record<string, KicadSymbol> = {}
	for (const lib of parsed) for (const [name, sym] of Object.entries(lib)) merged[name] ??= sym
	return merged
}
