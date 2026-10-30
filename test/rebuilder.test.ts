import { test } from "node:test"
import assert from "node:assert/strict"
import { Rebuilder } from "../src/tools/rebuilder.ts"
import { waitFor } from "./helpers.ts"

function gated() {
	const built: number[] = []
	let running = 0
	let maxRunning = 0
	const releases: (() => void)[] = []
	const r = new Rebuilder(async (rev) => {
		running++
		maxRunning = Math.max(maxRunning, running)
		built.push(rev)
		await new Promise<void>((res) => releases.push(res))
		running--
	})
	return { r, built, releases, max: () => maxRunning }
}

test("rebuilder coalesces requests made during a build", async () => {
	const g = gated()
	g.r.request(1)
	g.r.request(2)
	g.r.request(3)
	await waitFor(() => g.releases.length === 1)
	g.releases.shift()!()
	await waitFor(() => g.releases.length === 1)
	g.releases.shift()!()
	await waitFor(() => g.r.idle)
	assert.deepEqual(g.built, [1, 3])
})

test("rebuilder never overlaps builds", async () => {
	const g = gated()
	for (const rev of [1, 2, 3, 4]) g.r.request(rev)
	while (!g.r.idle) {
		await waitFor(() => g.releases.length > 0 || g.r.idle)
		g.releases.shift()?.()
	}
	assert.equal(g.max(), 1)
})

test("rebuilder ignores requests older than the last build", async () => {
	const g = gated()
	g.r.request(5)
	await waitFor(() => g.releases.length === 1)
	g.r.request(4)
	g.releases.shift()!()
	await waitFor(() => g.r.idle)
	assert.deepEqual(g.built, [5])
})
