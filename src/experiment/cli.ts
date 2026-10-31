import { join } from "node:path"
import { ROOT } from "../run.ts"
import { runExperiment } from "./run.ts"

// npm run experiment [-- --no-hardware] [--only narrower,i2c-pins] [--no-c]
// Real tools write out/experiment/results.json and docs/experiment.md; --no-hardware keeps both under out/experiment.
const argv = process.argv.slice(2)
const noHardware = argv.includes("--no-hardware")
const onlyIndex = argv.indexOf("--only")
const only = onlyIndex >= 0 ? argv[onlyIndex + 1]?.split(",") : undefined
const outDir = join(ROOT, "out", noHardware ? "experiment-stub" : "experiment")
const docsPath = noHardware ? join(outDir, "experiment.md") : join(ROOT, "docs", "experiment.md")
const results = await runExperiment({ outDir, docsPath, noHardware, only, armC: !argv.includes("--no-c"), log: (l) => console.log(`[experiment] ${l}`) })
console.log(`\n${results.length} trial(s); results: ${join(outDir, "results.json")}; table: ${docsPath}`)
process.exit(0)
