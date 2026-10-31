import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { serveHub } from "../src/dashboard/server.ts"

// The talk's /stage page: three cards, the finished runs from out/stage.json.
test("/stage serves the stage page; /api/stage reads stage.json (or says what's missing)", async () => {
	const root = mkdtempSync(join(tmpdir(), "bringup-stage-"))
	const hub = await serveHub({ outRoot: root, port: 0 })
	try {
		const page = await fetch(`${hub.url}/stage`)
		assert.equal(page.status, 200)
		assert.match(await page.text(), /id="stage-cards"/)
		assert.deepEqual(await (await fetch(`${hub.url}/api/stage`)).json(), { sensor: null, board: null })
		mkdirSync(join(root, "20261031-160000-aaaaaa"))
		writeFileSync(join(root, "stage.json"), JSON.stringify({ sensor: "20261031-160000-aaaaaa", board: "nope/../x" }))
		// Only run ids that exist under out/ (and look like one) come through.
		assert.deepEqual(await (await fetch(`${hub.url}/api/stage`)).json(), { sensor: "20261031-160000-aaaaaa", board: null })
	} finally {
		await hub.close()
	}
})
