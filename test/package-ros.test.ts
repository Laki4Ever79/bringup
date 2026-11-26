// A robot's build package carries its ROS 2 workspace (src/package/build.ts copyRosWorkspace): ROS is free, like every file.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { copyRosWorkspace } from "../src/package/build.ts"
import { tempDir } from "./helpers.ts"

test("the chassis's ROS workspace goes into the package's ros/src; no workspace, nothing copied", () => {
	const chassis = tempDir()
	const out = tempDir()
	assert.equal(copyRosWorkspace(chassis, out), false)
	assert.ok(!existsSync(join(out, "ros")))
	mkdirSync(join(chassis, "ros", "src", "rover_bringup", "urdf"), { recursive: true })
	writeFileSync(join(chassis, "ros", "src", "rover_bringup", "urdf", "rover.mock.urdf"), "<robot/>")
	mkdirSync(join(chassis, "ros", "src", "bringup_hardware"), { recursive: true })
	writeFileSync(join(chassis, "ros", "src", "bringup_hardware", "package.xml"), "<package/>")
	assert.equal(copyRosWorkspace(chassis, out), true)
	assert.equal(readFileSync(join(out, "ros", "src", "rover_bringup", "urdf", "rover.mock.urdf"), "utf8"), "<robot/>")
	assert.ok(existsSync(join(out, "ros", "src", "bringup_hardware", "package.xml")))
})
