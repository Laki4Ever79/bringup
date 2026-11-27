// Continuing a design (bringup continue, the MCP's continue_design, the hub's continue route): a new run seeded from an
// ended run's contract, its latest (contract.json) or revision N (contracts/rev-N.json, "branch from revision N"). The
// new run keeps its own folder, with continued-from.json pointing back; the ended run is never written to.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ContractSnapshot } from "../contract/types.ts"

export function continueSeed(from: string, revision?: number): { contract: ContractSnapshot; from: string } | { error: string } {
	if (!existsSync(join(from, "brief.md"))) return { error: `${from} is not a design's run folder (no brief.md)` }
	if (revision !== undefined && !(Number.isInteger(revision) && revision > 0)) return { error: `--rev takes a revision number, got ${revision}` }
	const file = revision === undefined ? join(from, "contract.json") : join(from, "contracts", `rev-${revision}.json`)
	if (!existsSync(file)) return { error: revision === undefined ? `${from} has no contract.json yet (the run never wrote one)` : `${from} has no revision ${revision} (contracts/rev-${revision}.json)` }
	const contract = JSON.parse(readFileSync(file, "utf8")) as ContractSnapshot
	if (!contract || typeof contract.revision !== "number" || !contract.values) return { error: `${file} is not a contract snapshot` }
	return { contract, from }
}
