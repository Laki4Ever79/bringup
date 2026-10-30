import { existsSync } from "node:fs"
import { appendRequest } from "./runner/requests.ts"

// tsx src/request.ts out/<runId> "make the board 60 mm wide"
const [outDir, ...words] = process.argv.slice(2)
const text = words.join(" ").trim()
if (!outDir || !text) {
	console.error('usage: tsx src/request.ts out/<runId> "<change request>"')
	process.exit(1)
}
if (!existsSync(outDir)) {
	console.error(`no run at ${outDir}`)
	process.exit(1)
}
const r = appendRequest(outDir, text)
console.log(`requested at ${r.at}: ${r.text}`)
