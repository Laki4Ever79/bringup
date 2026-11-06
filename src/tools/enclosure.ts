import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import type { EnclosureArtifact } from "../contract/consistency.ts"
import type { ContractSnapshot } from "../contract/types.ts"
import { antennaOverhang, micPorts, mountingHoles, placedByRole } from "../codegen/circuit.ts"
import { CASE_CLEARANCE_MM, caseOf, caseView, holeCentreZ, LANYARD_TAB, LID, MOUNT_TAB, STANDOFF, TEXT, type BuiltFeature } from "../contract/case.ts"

const run = promisify(execFile)

const TIMEOUT_MS = 120_000
const STDERR_TAIL_LINES = 40

// The case's fixed geometry lives with its checks (contract/case.ts); re-exported for the stub and older imports.
export { LID, STANDOFF } from "../contract/case.ts"
// The round opening through the floor under a bottom-port microphone (py/enclosure.py PORT_MM; the stub uses this).
export const PORT_MM = 2

// Input for py/enclosure.py, in the case view's frame (contract/case.ts caseView: the board plus the module's antenna,
// which hangs past one edge). The outline, connectors and mounting holes come from the contract (the holes are the
// ones the board codegen drills); frameShiftMm takes the built solids back to the contract's frame, and
// buildEnclosure does the same for what the script measures. Each sensor's position is the board generator's own
// placement (placeParts, which the board build also uses), so the lid's vent lands over it; the consistency check
// compares the vent with where the built board really put the sensor.
// ESP32-C3-MINI-1: 13.2 × 16.6 × 2.4 mm (datasheet v2.2, module dimensions).
const MODULE_HEIGHT_MM = 2.4

function antennaBox(s: ContractSnapshot, dx: number, dy: number, zBoardTop: number): { xMin: number; xMax: number; yMin: number; yMax: number; zMin: number; zMax: number } | null {
	const a = antennaOverhang(s)
	const o = s.values.outline
	if (!a || !o) return null
	const half = a.widthMm / 2
	const [xMin, xMax, yMin, yMax] =
		a.edge === "right" ? [o.widthMm, o.widthMm + a.overhangMm, a.alongMm - half, a.alongMm + half]
		: a.edge === "left" ? [-a.overhangMm, 0, a.alongMm - half, a.alongMm + half]
		: a.edge === "top" ? [a.alongMm - half, a.alongMm + half, o.heightMm, o.heightMm + a.overhangMm]
		: [a.alongMm - half, a.alongMm + half, -a.overhangMm, 0]
	const r = (v: number) => +v.toFixed(3)
	return { xMin: r(xMin + dx), xMax: r(xMax + dx), yMin: r(yMin + dy), yMax: r(yMax + dy), zMin: r(zBoardTop), zMax: r(zBoardTop + MODULE_HEIGHT_MM) }
}

export function enclosureSpec(s: ContractSnapshot): object {
	const real = s.values.outline
	if (!real) throw new Error("enclosure needs an outline in the contract")
	const { view, dx, dy } = caseView(s)
	const outline = view.values.outline!
	const at = <T extends { xMm: number; yMm: number }>(p: T): T => ({ ...p, xMm: +(p.xMm + dx).toFixed(3), yMm: +(p.yMm + dy).toFixed(3) })
	const holes = mountingHoles(s).map((h) => at({ ref: h.ref, xMm: h.x + real.widthMm / 2, yMm: h.y + real.heightMm / 2 }))
	const sensors = placedByRole(s, "sensor").map(({ ref, xMm, yMm }) => at({ ref, xMm, yMm }))
	// A bottom-port microphone's sound hole gets an opening through the floor.
	const ports = micPorts(s).map(at)
	const c = caseOf(view)
	// A copy: the caller may edit its spec (the print-check tests do), never the shared geometry.
	return structuredClone({
		// The size only: py/enclosure.py has no use for the reason behind it.
		outline: { widthMm: outline.widthMm, heightMm: outline.heightMm, thicknessMm: outline.thicknessMm },
		connectors: view.values.connectors ?? [],
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
		frameShiftMm: [dx, dy],
		// The antenna hanging past the board edge, as a box in the case frame from the board's top face up: the script
		// checks the built case and lid leave it clear.
		antenna: antennaBox(s, dx, dy, c.wallMm + STANDOFF.heightMm + real.thicknessMm),
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
	// The script measures in the case view's frame; back to the contract's (positions, and offsets along an edge).
	const { dx, dy } = caseView(s)
	const r3 = (v: number) => +v.toFixed(3)
	const back = <T extends { xMm?: number; yMm?: number }>(p: T): T => ({ ...p, ...(p.xMm !== undefined ? { xMm: r3(p.xMm - dx) } : {}), ...(p.yMm !== undefined ? { yMm: r3(p.yMm - dy) } : {}) })
	const along = <T extends { edge?: string; offsetMm?: number }>(p: T): T => (p.offsetMm === undefined ? p : { ...p, offsetMm: r3(p.offsetMm - (p.edge === "left" || p.edge === "right" ? dy : dx)) })
	const cutouts = (await read<EnclosureArtifact["cutouts"]>("cutouts.json")).map(along)
	const standoffs = (await read<{ xMm: number; yMm: number; holeMm: number }[]>("standoffs.json")).map(({ xMm, yMm, holeMm }) => back({ xMm, yMm, holeMm }))
	const { ok, issues } = await read<{ ok: boolean; issues: string[] }>("print.json")
	const vents = (await read<NonNullable<EnclosureArtifact["vents"]>>("vents.json")).map(back)
	const ports = existsSync(join(dir, "ports.json")) ? (await read<NonNullable<EnclosureArtifact["ports"]>>("ports.json")).map(back) : []
	const features = existsSync(join(dir, "features.json")) ? (await read<BuiltFeature[]>("features.json")).map((f) => along(back(f))) : []
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
