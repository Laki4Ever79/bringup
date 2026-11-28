// A build error Bringup caused itself never reaches an agent as the agent's own (lead-2, real CNC run 3, 27 Nov 2026:
// the Freerouting fallback wrote the catalog jack's custom footprint "dc091a250" raw, tscircuit refused it, and the
// architect proposed a stand-in footprint five times for a fault no contract change can fix). The rule: a line that
// names something Bringup chose (a footprint from its own catalog, a supplier lookup it makes) is code's, kept in the
// build log and the report for the code's owner, and left out of what the agent is asked to fix. When nothing else
// is left, no agent wakes.
import { loadCatalog } from "../tools/parts-search.ts"
import { fileURLToPath } from "node:url"

let footprints: Set<string> | null = null
const catalogFootprints = (): Set<string> => (footprints ??= new Set((loadCatalog(fileURLToPath(new URL("../..", import.meta.url))) as { footprint?: string }[]).map((p) => p.footprint).filter((f): f is string => Boolean(f))))

// Lines that are code's: a catalog footprint tscircuit can't parse (the generator wrote it), a supplier footprint
// lookup that failed (a network or registry miss, not a design choice), and the header line of an attempt whose
// every line is code's.
export function isCodeFaultLine(line: string, known: Set<string> = catalogFootprints()): boolean {
	const fp = /Invalid footprint prop on \w+ "[^"]+": "([^"]+)"/.exec(line)
	if (fp) return known.has(fp[1])
	return /Failed to fetch supplier footprint/.test(line)
}

// The error an agent is shown: the code's lines out, with a note when any were. Null when only code's lines (and the
// build's own boilerplate) are left, so no agent is woken for it.
export function agentFacingError(error: string, known?: Set<string>): string | null {
	const lines = error.split("\n")
	const code = lines.filter((l) => isCodeFaultLine(l, known))
	if (!code.length) return error
	const kept = lines.filter((l) => !isCodeFaultLine(l, known))
	const substantive = kept.filter((l) => l.trim() && !/^(Circuits\s+\d+ passed|⚠ Build completed with errors|Build exiting with code|full log:|Freerouting's layout: tscircuit build failed|Warning: \d+ chip overlaps)/.test(l.trim()))
	// The first line is the build's headline ("tscircuit build failed (...):"); something past it must be the agent's.
	if (substantive.length <= 1) return null
	return `${kept.join("\n")}\n(${code.length} line${code.length > 1 ? "s" : ""} Bringup itself caused, such as a footprint from its own catalog the router couldn't read, left out: not a design problem; they stay in the build log for Bringup's maintainers.)`
}
