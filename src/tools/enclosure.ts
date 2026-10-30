import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import type { EnclosureArtifact } from "../contract/consistency.ts"
import type { ContractSnapshot } from "../contract/types.ts"

const run = promisify(execFile)

const TIMEOUT_MS = 120_000
const STDERR_TAIL_LINES = 40

// Input for py/enclosure.py. Shell dimensions are fixed for now; the outline and connectors come from the contract.
export function enclosureSpec(s: ContractSnapshot): object {
	const { outline, connectors } = s.values
	if (!outline) throw new Error("enclosure needs an outline in the contract")
	return { outline, connectors: connectors ?? [], wallMm: 2, clearanceMm: 2, heightMm: 12 }
}

// Builds case.step, case.stl and cutouts.json under dir. The cutouts are measured from the built solid by the script.
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
	const cutouts = JSON.parse(await readFile(join(dir, "cutouts.json"), "utf8")) as EnclosureArtifact["cutouts"]
	return { revision, stlPath: join(dir, "case.stl"), stepPath: join(dir, "case.step"), cutouts }
}
