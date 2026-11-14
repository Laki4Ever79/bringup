// `npm run test:slow`: only the test files that hold a slow test (one whose skip names `slow` from test/helpers.ts),
// with BRINGUP_SLOW=1 so those tests run. `npm test` skips them. Extra args are passed to the test runner.
import { readdirSync, readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const files = readdirSync(join(root, "test"))
	.filter((f) => f.endsWith(".test.ts"))
	.filter((f) => /skip: slow\b/.test(readFileSync(join(root, "test", f), "utf8")))
	.map((f) => join("test", f))
console.log(`test:slow: ${files.length} files\n  ${files.join("\n  ")}`)
const r = spawnSync("npx", ["tsx", "--test", "--test-concurrency=3", ...process.argv.slice(2), ...files], { cwd: root, stdio: "inherit", env: { ...process.env, BRINGUP_SLOW: "1", MOZAIK_CREDENTIALS_FILE: "/dev/null", MOZAIK_API_KEY: "" } })
process.exit(r.status ?? 1)
