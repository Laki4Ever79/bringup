// The public repo without the hosted page (the open-core split, 25 Nov 2026): Bringup's engine, MCP server, checks,
// catalog and every file a design produces stay public and free; the page (3D view and simulation, editing, logs and
// debugging) is the paid hosted product and stays in the private repo.
//
// It builds one commit on top of the public main whose tree is the private ref minus the page: src/dashboard/, the
// one-command demo that serves it, and every source, test or script that statically imports them (followed through
// the import graph, so nothing that needs the page is published broken). A dynamic import() is optional by design
// (the build package's assembly pictures load the page only when it is installed) and doesn't count. package.json
// loses the scripts that run private files.
//
//   npx tsx scripts/publish-public.ts                 # dry run: what would be removed, what the commit would be
//   npx tsx scripts/publish-public.ts --push          # commit on origin/main and push it (a fast-forward)
//   npx tsx scripts/publish-public.ts --ref private/adopt --public origin/main
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, normalize } from "node:path"

// The page and what serves it: the page itself, the demo that launches it, its design doc, and the live simulation
// session behind its Simulation chapter (src/sim, py/mech/live.py: "simulation in 3D" is the paid part, 25 Nov 2026).
// Bringup Studio's server (cloud/: accounts, the mirror, payments) is private (the open-core plan, 26 Nov 2026).
// The finished example designs (examples/, the page's home screen) are private too (the user, 25 Nov 2026: "examples
// should stay on private repo"); examples/learn stays public: the datasheet fixtures the engine's mock and tests read.
export const PRIVATE_ROOTS = ["src/dashboard/", "src/demo.ts", "docs/design/dashboard.md", "src/sim/", "py/mech/live.py", "examples/", "cloud/", "docs/studio-guide.md", "docs/img/studio-guide/", "docs/rename.md", "scripts/gallery-pack.ts", "docs/launch/"]
export const PUBLIC_INSIDE = ["examples/learn/"]
// Never in a public tree (they are gitignored; a hit means something slipped in).
const FORBIDDEN = [/(^|\/)\.env(\.(?!example$)[^/]*)?$/, /^catalog\/learned\//, /(^|\/)\.cache\//]
const CODE = /\.(ts|mts|js|mjs|tsx)$/

const STATIC_IMPORT = /(?:^|[\s;])(?:import|export)\s[^"'`]*?from\s*["'](\.{1,2}\/[^"']+)["']|(?:^|[\s;])import\s*["'](\.{1,2}\/[^"']+)["']/gm
// import("./x") with a literal: the compiler resolves it like a static one, so it counts too. Engine code that loads the
// page only when present names it through a variable (assembly-pictures.ts), which nothing resolves.
const DYNAMIC_IMPORT = /\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g

export function staticImports(source: string): string[] {
	const out: string[] = []
	for (const m of source.matchAll(STATIC_IMPORT)) out.push(m[1] ?? m[2])
	for (const m of source.matchAll(DYNAMIC_IMPORT)) out.push(m[1])
	return out
}

// The file an import names: as written, or the .ts behind a .js specifier.
export function resolveImport(from: string, spec: string, files: Set<string>): string | null {
	const p = normalize(join(dirname(from), spec))
	for (const c of [p, p.replace(/\.js$/, ".ts"), `${p}.ts`, `${p}/index.ts`]) if (files.has(c)) return c
	return null
}

const underRoots = (f: string) => !PUBLIC_INSIDE.some((p) => f.startsWith(p)) && PRIVATE_ROOTS.some((r) => (r.endsWith("/") ? f.startsWith(r) : f === r))

// A test or script that reads a private example by a literal file path (examples/rover-pi/boards/main/contract.json)
// would fail in the public tree: it goes too. Only the data roots count: code roots are followed through imports, and
// tools like this one name the roots themselves.
const DATA_ROOTS = ["examples/"]
export function readsPrivatePath(source: string, isPrivate: (f: string) => boolean = underRoots): boolean {
	for (const m of source.matchAll(/["'`/]([\w-]+\/[\w./-]*\.\w+)["'`]/g)) if (DATA_ROOTS.some((r) => m[1].startsWith(r)) && isPrivate(m[1])) return true
	return false
}

// Every file to leave out. The page modules the engine reaches (src/ and bin/ outside the page, followed through
// static imports) stay public, shared, until they move into the engine; the rest of the page is private, and so is
// anything that statically imports a private file, until nothing changes.
export function privateFiles(files: string[], read: (f: string) => string): { out: Set<string>; shared: string[] } {
	const all = new Set(files)
	const deps = new Map<string, string[]>()
	for (const f of files) if (CODE.test(f)) deps.set(f, staticImports(read(f)).map((s) => resolveImport(f, s, all)).filter((x): x is string => x !== null))
	const reach = new Set<string>()
	const stack = files.filter((f) => CODE.test(f) && /^(src|bin)\//.test(f) && !underRoots(f))
	while (stack.length) {
		const f = stack.pop()!
		if (reach.has(f)) continue
		reach.add(f)
		stack.push(...(deps.get(f) ?? []))
	}
	// A .js module's types (its .d.ts beside it) go wherever it goes.
	for (const f of [...reach]) if (f.endsWith(".js") && all.has(f.replace(/\.js$/, ".d.ts"))) reach.add(f.replace(/\.js$/, ".d.ts"))
	const shared = files.filter((f) => underRoots(f) && reach.has(f)).sort()
	const isPrivate = (f: string) => underRoots(f) && !reach.has(f)
	const out = new Set(files.filter((f) => isPrivate(f) || (CODE.test(f) && /^(test|scripts)\//.test(f) && readsPrivatePath(read(f), isPrivate))))
	for (let changed = true; changed; ) {
		changed = false
		for (const [f, ds] of deps) if (!out.has(f) && ds.some((d) => out.has(d))) (out.add(f), (changed = true))
	}
	return { out, shared }
}

// package.json without the scripts that run a left-out file.
export function publicPackageJson(text: string, removed: Set<string>): string {
	const pkg = JSON.parse(text)
	for (const [k, v] of Object.entries<string>(pkg.scripts ?? {})) if ([...removed].some((f) => v.includes(f)) || PRIVATE_ROOTS.some((r) => v.includes(r))) delete pkg.scripts[k]
	return JSON.stringify(pkg, null, "\t") + "\n"
}

function git(args: string[], opts: { env?: NodeJS.ProcessEnv; input?: string } = {}): string {
	return execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28, env: { ...process.env, ...opts.env }, input: opts.input }).trimEnd()
}

function main() {
	const argv = process.argv.slice(2)
	const opt = (name: string, dflt: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt)
	const ref = opt("--ref", "private/adopt")
	const pub = opt("--public", "origin/main")
	const push = argv.includes("--push")
	git(["fetch", "-q", ref.split("/")[0]])
	git(["fetch", "-q", pub.split("/")[0]])
	const files = git(["ls-tree", "-r", "--name-only", ref]).split("\n")
	const bad = files.filter((f) => FORBIDDEN.some((re) => re.test(f)))
	if (bad.length) throw new Error(`refusing: ${ref} tracks ${bad.join(", ")}`)
	const { out: removed, shared } = privateFiles(files, (f) => git(["show", `${ref}:${f}`]))
	// Engine code the page drags out would publish a broken engine: refuse.
	const engine = [...removed].filter((f) => /^(src|bin)\//.test(f) && !underRoots(f))
	if (engine.length) throw new Error(`engine files would be left out because they import the page: ${engine.join(", ")}`)
	const idx = join(mkdtempSync(join(tmpdir(), "bringup-public-")), "index")
	const env = { GIT_INDEX_FILE: idx }
	try {
		git(["read-tree", ref], { env })
		// -f: the index is a throwaway built from the ref, so this checkout's own HEAD or files must never block it (they lag the ref when another session pushed meanwhile).
		git(["rm", "--cached", "-f", "-q", "--pathspec-from-file=-"], { env, input: [...removed].join("\n") + "\n" })
		const pkgBlob = git(["hash-object", "-w", "--stdin"], { input: publicPackageJson(git(["show", `${ref}:package.json`]), removed) })
		git(["update-index", "--cacheinfo", `100644,${pkgBlob},package.json`], { env })
		const tree = git(["write-tree"], { env })
		const parentTree = git(["rev-parse", `${pub}^{tree}`])
		const src = git(["rev-parse", "--short", ref])
		const roots = [...removed].filter((f) => f.startsWith("src/dashboard/")).length
		console.log(`${ref} ${src}: ${files.length} files, ${removed.size} left out (${roots} under src/dashboard, ${removed.size - roots} that import them)`)
		for (const f of [...removed].filter((x) => !x.startsWith("src/dashboard/")).sort()) console.log(`  - ${f}`)
		console.log(`page modules the engine still needs (public until they move): ${shared.map((f) => f.replace("src/dashboard/", "")).join(", ")}`)
		if (tree === parentTree) return console.log(`${pub} already has this tree: nothing to publish`)
		const subject = git(["log", "-1", "--format=%s", ref])
		const commit = git(["commit-tree", tree, "-p", pub, "-m", `sync from the private repo at ${src}: ${subject}\n\nThe hosted page (src/dashboard) stays private: ${removed.size} files left out (scripts/publish-public.ts).`])
		console.log(`commit ${commit} on ${pub}`)
		if (!push) return console.log("dry run: --push to publish it")
		git(["push", "-q", pub.split("/")[0], `${commit}:refs/heads/${pub.split("/").slice(1).join("/")}`])
		console.log(`pushed ${commit} to ${pub}`)
	} finally {
		rmSync(dirname(idx), { recursive: true, force: true })
	}
}

// The npm package's page files: exactly the shared ones (package.json "files" re-includes them after !src/dashboard/**).
export function sharedFromWorkingTree(): string[] {
	const files = git(["ls-files"]).split("\n")
	return privateFiles(files, (f) => execFileSync("cat", [f], { encoding: "utf8" })).shared
}

if (import.meta.url === `file://${process.argv[1]}`) (process.argv.includes("--shared") ? console.log(sharedFromWorkingTree().join("\n")) : main())
