// npm run test:affected [-- <file>…] [--run] [--wide | --deep] [--base <ref>]
// The test files a change touches: the tests that import a changed file, plus a hand list for what imports can't show
// (integration tests that build boards or firmware from files read at run time, data and templates). --wide also takes
// tests one module further away, --deep every chain (shared modules reach most of the suite that way). Type-only
// imports don't count: `npm run typecheck` covers those. With no files it takes the change against the base branch
// (default adopt) plus uncommitted and untracked work. --run runs the list.
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

// What imports can't show: a changed path (prefix) → test files that exercise it at run time.
export const HAND: Record<string, string[]> = {
	"src/codegen/circuit.ts": ["board-build.int", "space", "debug-port", "en-reset", "bringup-pads", "bench-manifest", "usb-wake", "circuit-codegen"],
	"src/tools/board.ts": ["board-build.int"],
	"catalog/mcu/": ["mcu-profile", "mcu-solver", "mcu-board", "mcu-select", "mcu-pins", "mcu-crystal", "mcu-firmware", "mcu-firmware.int"],
	"catalog/parts.json": ["parts-search", "catalog-facts", "bom"],
	"templates/fw/": ["firmware.int", "mcu-firmware.int", "mcu-firmware-vendors.int", "firmware-codegen"],
	"templates/wokwi/": ["wokwi", "wokwi.int"],
	"src/dashboard/": ["dashboard", "system-page"],
	"src/tools/renode.ts": ["mcu-sim", "mcu-system-link.int"],
	"src/system/linktest.ts": ["system-link.int", "mcu-system-link.int", "linktest-i2c.int", "linktest-usb.int"],
}

// Static imports and re-exports (group 1 set: type-only) and dynamic import()s of relative paths.
const STATIC = /\b(?:import|export)\s+(type\s+)?(?:[\w*{}\s,]+?\s+from\s+)?["'](\.{1,2}\/[^"']+)["']/g
const DYNAMIC = /\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']/g

function walk(dir: string, out: string[] = []): string[] {
	if (!existsSync(dir)) return out
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name.startsWith(".")) continue
		const p = join(dir, name)
		if (statSync(p).isDirectory()) walk(p, out)
		else if (/\.(m?ts|tsx)$/.test(name)) out.push(p)
	}
	return out
}

// file (repo-relative) → the repo-relative files it imports.
export function importGraph(root: string, dirs = ["src", "test", "scripts", "perf"]): Map<string, string[]> {
	const graph = new Map<string, string[]>()
	for (const abs of dirs.flatMap((d) => walk(join(root, d)))) {
		const deps: string[] = []
		const text = readFileSync(abs, "utf8")
		const specs = [...[...text.matchAll(STATIC)].filter((m) => !m[1]).map((m) => m[2]), ...[...text.matchAll(DYNAMIC)].map((m) => m[1])]
		for (const spec of specs) {
			const target = resolve(dirname(abs), spec)
			const hit = [target, `${target}.ts`, join(target, "index.ts")].find((p) => existsSync(p) && statSync(p).isFile())
			if (hit) deps.push(relative(root, hit))
		}
		graph.set(relative(root, abs), deps)
	}
	return graph
}

const isTest = (f: string) => /^test\/.*\.test\.ts$/.test(f)
const testFile = (name: string) => `test/${name}.test.ts`

// The test files reached from the changed files; sorted, existing only. A changed file's tests are the tests that
// import it, and the tests of the modules in its directory that import it directly (select.ts uses solver.ts:
// mcu-select tests both); not src/ itself, where main.ts imports everything.
// The hand list applies to the changed file and to every module that imports it (pins.ts → circuit.ts → board
// tests). depth 2 (--wide) takes the tests of every importing module; Infinity (--deep) follows every chain, which
// for shared modules (types, pin names) is most of the suite.
export function affectedTests(changed: string[], graph: Map<string, string[]>, root: string, depth = 1, hand = HAND): string[] {
	const importers = new Map<string, string[]>()
	for (const [file, deps] of graph) for (const d of deps) importers.set(d, [...(importers.get(d) ?? []), file])
	const of = (f: string) => importers.get(f) ?? []
	const tests = new Set<string>()
	const addHand = (f: string) => {
		for (const [prefix, names] of Object.entries(hand)) if (f === prefix || (prefix.endsWith("/") && f.startsWith(prefix))) names.forEach((n) => tests.add(testFile(n)))
	}
	for (const origin of changed) {
		if (isTest(origin)) tests.add(origin)
		addHand(origin)
		// Modules whose tests count: the file, its direct importers in its directory, and with depth ≥ 2 every importer.
		const reach = new Map<string, number>([[origin, 0]])
		const queue = [origin]
		while (queue.length) {
			const f = queue.shift()!
			const d = reach.get(f)!
			for (const imp of of(f)) {
				if (isTest(imp) || reach.has(imp)) continue
				if (d === 0) addHand(imp)
				const beside = d === 0 && dirname(origin) !== "src" && dirname(imp) === dirname(origin)
				if (beside || d + 1 < depth) { reach.set(imp, d + 1); queue.push(imp) }
			}
		}
		for (const f of reach.keys()) for (const imp of of(f)) if (isTest(imp)) tests.add(imp)
	}
	return [...tests].filter((t) => existsSync(join(root, t))).sort()
}

function changedFiles(root: string, base: string): string[] {
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean)
	return [...new Set([...git("diff", "--name-only", `${base}...HEAD`), ...git("diff", "--name-only", "HEAD"), ...git("ls-files", "--others", "--exclude-standard")])]
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const root = resolve(dirname(new URL(import.meta.url).pathname), "..")
	const args = process.argv.slice(2)
	const run = args.includes("--run")
	const bi = args.indexOf("--base")
	const base = bi >= 0 ? args[bi + 1] : "adopt"
	const files = args.filter((a, i) => !a.startsWith("--") && (bi < 0 || i !== bi + 1))
	const changed = files.length ? files.map((f) => relative(root, resolve(f))) : changedFiles(root, base)
	const tests = affectedTests(changed, importGraph(root), root, args.includes("--deep") ? Infinity : args.includes("--wide") ? 2 : 1)
	const unit = tests.filter((t) => !/\.(int|browser|mock)\.test\.ts$/.test(t))
	const slow = tests.filter((t) => !unit.includes(t))
	console.error(`${changed.length} changed file(s) → ${unit.length} unit + ${slow.length} integration/browser test file(s)`)
	for (const t of tests) console.log(t)
	if (run && tests.length) {
		const r = spawnSync("npx", ["tsx", "--test", ...tests], { cwd: root, stdio: "inherit", env: { ...process.env, MOZAIK_CREDENTIALS_FILE: "/dev/null", MOZAIK_API_KEY: "" } })
		process.exit(r.status ?? 1)
	}
}
