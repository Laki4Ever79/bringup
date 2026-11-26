// The build package's robot pictures (src/package/assembly-pictures.ts): engine code, no page.
import { test } from "node:test"
import assert from "node:assert/strict"

test("the build package takes no pictures of a directory without a built chassis, and says so", async () => {
	const { assemblyPictures } = await import("../src/package/assembly-pictures.ts")
	const { tempDir } = await import("./helpers.ts")
	const r = await assemblyPictures("python3", process.cwd(), tempDir(), tempDir())
	assert.deepEqual(r.files, [])
	assert.match(r.note!, /holds no built chassis/)
})
