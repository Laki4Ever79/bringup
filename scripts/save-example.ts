// npx tsx scripts/save-example.ts <run or system folder> <name> "<the sentence that made it>"
// Copies a finished run into examples/<name>, trimmed to what the start screen's viewer reads.
import { saveExample } from "../src/dashboard/examples.ts"

const [source, name, sentence] = process.argv.slice(2)
if (!source || !name || !sentence) {
	console.error('usage: npx tsx scripts/save-example.ts <run or system folder> <name> "<sentence>"')
	process.exit(2)
}
const meta = saveExample(source, name, sentence, "examples")
console.log(`examples/${name}: ${meta.boards.map((b) => b.name).join(", ")}`)
