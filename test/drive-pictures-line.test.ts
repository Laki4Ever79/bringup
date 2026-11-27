// The report's line about the drive's pictures (src/mechanics/report.ts drivePicturesLine): where they are and which
// drive they show, or how to make them.
import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { drivePicturesLine } from "../src/mechanics/report.ts"
import { tempDir } from "./helpers.ts"

test("the report points at the drive's pictures, or says how to make them", () => {
	const run = tempDir()
	const driveDir = join(run, "drive", "rev-13")
	mkdirSync(driveDir, { recursive: true })
	assert.match(drivePicturesLine(driveDir), /not made yet \(ask for them: get_pictures with drive: true/)
	mkdirSync(join(run, "pictures", "drive"), { recursive: true })
	writeFileSync(join(run, "pictures", "drive", "pictures.json"), JSON.stringify({ revision: 13, files: ["drive.gif", "drive-track.png"] }))
	const line = drivePicturesLine(driveDir)
	assert.match(line, /^- Pictures of the drive \(revision 13\): .*pictures\/drive\/drive\.gif \(the whole drive, animated\), drive-track\.png/)
	assert.match(drivePicturesLine(undefined), /not made yet/)
})
