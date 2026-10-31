import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import type { EnclosureArtifact } from "../contract/consistency.ts"
import type { ContractSnapshot } from "../contract/types.ts"
import { mountingHoles, placeParts } from "../codegen/circuit.ts"

const run = promisify(execFile)

const TIMEOUT_MS = 120_000
const STDERR_TAIL_LINES = 40

// Board mounting: M2 self-tapping screws (ISO 7049 / PT style) straight into a 1.6 mm pilot hole in a 5 mm post.
// No inserts and no soldering iron; PLA and PETG hold a few re-assemblies, which is what a prototype needs.
export const STANDOFF = { heightMm: 3, outerMm: 5, pilotMm: 1.6 }
// Lid: a flat plate with a lip that drops 3 mm into the case, 0.2 mm clearance per side. It prints plate-down with
// no overhangs, and at 0.2 mm layers the first-layer squish takes up most of the gap, so it sits as a light press
// fit. A snap-fit was the alternative; its cantilevers are brittle in PLA and need tuning per printer.
export const LID = { plateMm: 2, lipMm: 3, lipWallMm: 1.6, clearanceMm: 0.2 }

// Input for py/enclosure.py. The outline, connectors and mounting holes come from the contract (the holes are the
// ones the board codegen drills); the shell dimensions are fixed. Each sensor's position is the board generator's own
// placement (placeParts, which the board build also uses), so the lid's vent lands over it; the consistency check
// compares the vent with where the built board really put the sensor.
export function enclosureSpec(s: ContractSnapshot): object {
	const { outline, connectors } = s.values
	if (!outline) throw new Error("enclosure needs an outline in the contract")
	const holes = mountingHoles(s).map((h) => ({ ref: h.ref, xMm: h.x + outline.widthMm / 2, yMm: h.y + outline.heightMm / 2 }))
	const sensorRefs = new Set((s.values.parts ?? []).filter((p) => p.role === "sensor").map((p) => p.ref))
	const sensors = sensorRefs.size ? placeParts(s).filter((p) => sensorRefs.has(p.ref)).map((p) => ({ ref: p.ref, xMm: p.x + outline.widthMm / 2, yMm: p.y + outline.heightMm / 2 })) : []
	return { outline, connectors: connectors ?? [], holes, sensors, wallMm: 2, clearanceMm: 2, heightMm: 14, standoff: STANDOFF, lid: LID }
}

// Builds the case and lid (STEP + STL), cutouts.json, standoffs.json and print.json under dir. Cutouts and standoffs
// are measured from the built solid by the script; print.json is its print check.
export async function buildEnclosure(python: string, root: string, dir: string, s: ContractSnapshot, revision: number): Promise<EnclosureArtifact> {
	await mkdir(dir, { recursive: true })
	const specPath = join(dir, "spec.json")
	await writeFile(specPath, JSON.stringify(enclosureSpec(s), null, 2))
	try {
		await run(python, [join(root, "py/enclosure.py"), specPath, dir], { timeout: TIMEOUT_MS })
	} catch (e) {
		const err = e as { stderr?: string; killed?: boolean; message: string }
		const tail = (err.stderr ?? "").trimEnd().split("\n").slice(-STDERR_TAIL_LINES).join("\n")
		const why = err.killed ? `timed out after ${TIMEOUT_MS / 1000} s` : "failed"
		throw new Error(`enclosure build ${why}: ${tail || err.message}`)
	}
	const read = async <T>(name: string) => JSON.parse(await readFile(join(dir, name), "utf8")) as T
	const cutouts = await read<EnclosureArtifact["cutouts"]>("cutouts.json")
	const standoffs = (await read<{ xMm: number; yMm: number; holeMm: number }[]>("standoffs.json")).map(({ xMm, yMm, holeMm }) => ({ xMm, yMm, holeMm }))
	const { ok, issues } = await read<{ ok: boolean; issues: string[] }>("print.json")
	const vents = await read<NonNullable<EnclosureArtifact["vents"]>>("vents.json")
	return {
		revision,
		stlPath: join(dir, "case.stl"),
		stepPath: join(dir, "case.step"),
		lidStlPath: join(dir, "lid.stl"),
		lidStepPath: join(dir, "lid.step"),
		cutouts,
		standoffs,
		printCheck: { ok, issues },
		vents,
	}
}
