// get_pictures compare: the design before and after a change in one image (py/overview.py rows: before above after,
// the board, the assembly and the motion side by side, the panels that changed framed), with the one-line summary under
// it. Each side's pictures are made from that revision's own builds (src/package/compare.ts designAt) into
// pictures/rev-<n>/, and reused when they're already there.
//
// Public, in the engine.
import { existsSync, readdirSync } from "node:fs"
import { basename, join } from "node:path"
import { armPictures, armSimPictures, assemblyPictures, casePictures, cncSimPictures, drivePictures } from "./assembly-pictures.ts"
import { compareDesigns, designAt, type Comparison, type DesignAt } from "./compare.ts"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)

type Panel = { label: string; path: string } | null

// A picture already made in dir, or make it: the newest file matching `want` after `make`.
async function picture(dir: string, want: RegExp, make: () => Promise<unknown>): Promise<string | null> {
	const find = () => (existsSync(dir) ? readdirSync(dir).filter((f) => want.test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((f) => join(dir, f)) : [])
	if (!find().length) await make()
	return find().at(-1) ?? null
}

async function panels(python: string, root: string, runDir: string, d: DesignAt): Promise<{ board: Panel; assembly: Panel; motion: Panel }> {
	const out = (src: string | undefined) => join(runDir, "pictures", `${basename(join(src ?? "x", ".."))}-${basename(src ?? "none")}`)
	const board: Panel = d.dirs.board ? { label: "the board", path: join(d.dirs.board, "board.png") } : null
	let assembly: Panel = null
	if (d.dirs.chassis) {
		const dir = out(d.dirs.chassis)
		const p = await picture(join(dir, "assembly"), /^step-\d+-.*\.png$/, () => assemblyPictures(python, root, d.dirs.chassis!, dir))
		if (p) assembly = { label: "assembled", path: p }
	} else if (d.dirs.arm) {
		const dir = out(d.dirs.arm)
		const p = await picture(join(dir, "assembly"), /^step-\d+-.*\.png$/, () => armPictures(python, root, join(d.dirs.arm!, "arm", "posed"), dir))
		if (p) assembly = { label: "assembled", path: p }
	} else if (d.dirs.enclosure) {
		const dir = out(d.dirs.enclosure)
		const p = await picture(join(dir, "assembly"), /^exploded\.png$/, () => casePictures(python, root, d.dirs.enclosure!, dir))
		if (p) assembly = { label: "in its case", path: p }
	}
	let motion: Panel = null
	if (d.dirs.drive && d.dirs.chassis) {
		const dir = out(d.dirs.drive)
		const p = await picture(join(dir, "drive"), /^drive-track\.png$/, () => drivePictures(python, root, d.dirs.chassis!, d.dirs.drive!, dir))
		if (p) motion = { label: "its drive (simulated)", path: p }
	} else if (d.dirs.armsim && d.dirs.arm) {
		const dir = out(d.dirs.armsim)
		const p = await picture(join(dir, "armsim"), /^arm-1-pick\.png$/, () => armSimPictures(python, root, join(d.dirs.arm!, "arm", "posed"), d.dirs.armsim!, dir))
		if (p) motion = { label: "pick-and-place (simulated)", path: p }
	} else if (d.dirs.cncsim && existsSync(join(d.dirs.cncsim, "toolpath.json"))) {
		const dir = out(d.dirs.cncsim)
		const p = await picture(join(dir, "cncsim"), /^cnc-toolpath\.png$/, () => cncSimPictures(python, root, d.dirs.cncsim!, dir))
		if (p) motion = { label: "the toolpath grblHAL ran", path: p }
	}
	return { board, assembly, motion }
}

export interface ComparePictures {
	file: string | null
	comparison: Comparison
	note: string | null
}

export async function comparePictures(python: string, root: string, runDir: string, before: number, after: number, request?: string): Promise<ComparePictures> {
	const a = designAt(runDir, before), b = designAt(runDir, after)
	const comparison = compareDesigns(a, b)
	const [pa, pb] = [await panels(python, root, runDir, a), await panels(python, root, runDir, b)]
	// The motion panel says its verdict, before and after.
	const v = comparison.details.verdicts[0]
	const withVerdict = (p: Panel, side: "before" | "after"): Panel => (p && v ? { ...p, label: `${p.label}: ${v[side] ?? "not run"}` } : p)
	const row = (p: { board: Panel; assembly: Panel; motion: Panel }, side: "before" | "after") =>
		(
			[
				["board", p.board],
				["assembly", p.assembly],
				["motion", withVerdict(p.motion, side)],
			] as const
		)
			.filter(([, x]) => x)
			.map(([k, x]) => `${side === "after" && comparison.changed[k] ? "*" : ""}${x!.label}=${x!.path}`)
	const file = join(runDir, "pictures", `compare-rev-${before}-rev-${after}.png`)
	const quoted = request ? `: "${request.length > 60 ? request.slice(0, 57) + "..." : request}"` : ""
	const args = [file, `--row=before (revision ${before})`, ...row(pa, "before"), `--row=after (revision ${after})${quoted}`, ...row(pb, "after"), `--caption=${comparison.summary}`]
	try {
		await exec(python, [join(root, "py", "overview.py"), ...args], { timeout: 120_000 })
		return { file: existsSync(file) ? file : null, comparison, note: existsSync(file) ? null : "no comparison picture: py/overview.py wrote nothing" }
	} catch (e) {
		return { file: null, comparison, note: `no comparison picture: py/overview.py stopped: ${String((e as { stderr?: string }).stderr || e).trim().split("\n").pop()}` }
	}
}
