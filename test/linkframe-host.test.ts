// The link frame (templates/fw/include/linkframe.h), the one codec every message kind uses, compiled with this
// computer's g++ against a stub Arduino.h and run: round trip, resync after garbage, a frame split across reads, a bad
// checksum, an over-long length, the largest payload, two frames back to back. Skipped without g++.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { join } from "node:path"
import { ROOT } from "../src/run.ts"
import { tempDir } from "./helpers.ts"

const gxx = spawnSync("g++", ["--version"]).status === 0

test("the link frame round-trips and drops what is bad, compiled on this computer", { skip: gxx ? false : "needs g++" }, () => {
	const bin = join(tempDir(), "linkframe_test")
	execFileSync("g++", ["-std=c++17", "-Wall", "-Werror", "-I", join(ROOT, "test/fw-host"), "-I", join(ROOT, "templates/fw/include"), join(ROOT, "test/fw-host/linkframe_test.cpp"), "-o", bin])
	const r = spawnSync(bin, { encoding: "utf8" })
	const cases = ["roundtrip", "garbage-before", "split", "bad-checksum", "too-long", "max-payload", "back-to-back", "false-sync"]
	for (const c of cases) assert.match(r.stdout, new RegExp(`^PASS ${c}$`, "m"), r.stdout)
	assert.equal(r.status, 0, r.stdout)
})
