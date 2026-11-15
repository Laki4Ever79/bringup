import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

// The run's brief (brief.md in its out dir), or "" without one. Every full check takes it, during the run and at its
// end, so the final status and the report see the same findings the agents were woken for.
export const readBrief = (outDir: string) => (existsSync(join(outDir, "brief.md")) ? readFileSync(join(outDir, "brief.md"), "utf8") : "")
