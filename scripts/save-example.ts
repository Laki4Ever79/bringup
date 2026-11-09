// npx tsx scripts/save-example.ts <run or system folder> <name> "<the sentence that made it>" ["<title>"]
// Copies a finished run into examples/<name>, trimmed to what the start screen's viewer reads.
import { saveExample } from "../src/dashboard/examples.ts"

const [source, name, sentence, title] = process.argv.slice(2)
if (!source || !name || !sentence) {
	console.error('usage: npx tsx scripts/save-example.ts <run or system folder> <name> "<sentence>" ["<title>"]')
	process.exit(2)
}
const meta = saveExample(source, name, sentence, "examples", title)
console.log(`examples/${name}: ${meta.boards.map((b) => b.name).join(", ")}`)
