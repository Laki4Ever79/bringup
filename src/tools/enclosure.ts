import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import type { EnclosureArtifact } from "../contract/consistency.ts"
import type { ContractSnapshot } from "../contract/types.ts"
import { micPorts, mountingHoles, placedByRole } from "../codegen/circuit.ts"
import { CASE_CLEARANCE_MM, caseOf, holeCentreZ, LANYARD_TAB, LID, MOUNT_TAB, STANDOFF, TEXT, type BuiltFeature } from "../contract/case.ts"

const run = promisify(execFile)

const TIMEOUT_MS = 120_000
const STDERR_TAIL_LINES = 40

// The case's fixed geometry lives with its checks (contract/case.ts); re-exported for the stub and older imports.
export { LID, STANDOFF } from "../contract/case.ts"
// The round opening through the floor under a bottom-port microphone (py/enclosure.py PORT_MM; the stub uses this).
export const PORT_MM = 2

// Input for py/enclosure.py. The outline, connectors and mounting holes come from the contract (the holes are the
// ones the board codegen drills); the shell dimensions are fixed. Each sensor's position is the board generator's own
// placement (placeParts, which the board build also uses), so the lid's vent lands over it; the consistency check
// compares the vent with where the built board really put the sensor.
export function enclosureSpec(s: ContractSnapshot): object {
	const { outline, connectors } = s.values
	if (!outline) throw new Error("enclosure needs an outline in the contract")
	const holes = mountingHoles(s).map((h) => ({ ref: h.ref, xMm: h.x + outline.widthMm / 2, yMm: h.y + outline.heightMm / 2 }))
	const sensors = placedByRole(s, "sensor").map(({ ref, xMm, yMm }) => ({ ref, xMm, yMm }))
	// A bottom-port microphone's sound hole gets an opening through the floor.
	const ports = micPorts(s)
	const c = caseOf(s)
	// A copy: the caller may edit its spec (the print-check tests do), never the shared geometry.
	return structuredClone({
		// The size only: py/enclosure.py has no use for the reason behind it.
		outline: { widthMm: outline.widthMm, heightMm: outline.heightMm, thicknessMm: outline.thicknessMm },
		connectors: connectors ?? [],
		holes,
		sensors,
		ports,
		wallMm: c.wallMm,
		clearanceMm: CASE_CLEARANCE_MM,
		heightMm: c.heightMm,
		standoff: STANDOFF,
		lid: LID,
		features: c.features,
		featureGeometry: { mountTab: MOUNT_TAB, lanyardTab: LANYARD_TAB, text: TEXT, holeZMm: holeCentreZ(c) },
	})
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
	const ports = existsSync(join(dir, "ports.json")) ? await read<NonNullable<EnclosureArtifact["ports"]>>("ports.json") : []
	const features = existsSync(join(dir, "features.json")) ? await read<BuiltFeature[]>("features.json") : []
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
		ports,
		features,
		featuresAsked: caseOf(s).features,
	}
}
