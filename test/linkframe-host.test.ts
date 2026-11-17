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
	const cases = ["roundtrip", "garbage-before", "split", "bad-checksum", "too-long", "max-payload", "back-to-back", "resync", "zeros", "empty"]
	for (const c of cases) assert.match(r.stdout, new RegExp(`^PASS ${c}$`, "m"), r.stdout)
	assert.equal(r.status, 0, r.stdout)
})

// The payload inside the frame (templates/fw/include/linkcbor.h, 16 Nov 2026): CBOR (RFC 8949) checked against the
// RFC's Appendix A bytes, a message read back by field name, and what another encoder may send (half/double floats).
test("the link payload codec writes and reads CBOR as RFC 8949 gives it, compiled on this computer", { skip: gxx ? false : "needs g++" }, () => {
	const bin = join(tempDir(), "linkcbor_test")
	execFileSync("g++", ["-std=c++17", "-Wall", "-Werror", "-I", join(ROOT, "test/fw-host"), "-I", join(ROOT, "templates/fw/include"), join(ROOT, "test/fw-host/linkcbor_test.cpp"), "-o", bin])
	const r = spawnSync(bin, { encoding: "utf8" })
	for (const c of ["uint", "negative", "int32-min", "float", "map", "overflow", "roundtrip", "truncated", "half", "double", "uint64", "not-ours"]) assert.match(r.stdout, new RegExp(`^PASS ${c}$`, "m"), r.stdout)
	assert.equal(r.status, 0, r.stdout)
})

// CAN messages as Cyphal/CAN v1.0 (templates/fw/include/linkcyphal.h, 17 Nov 2026): the identifier checked against the
// specification's heartbeat example (subject 7509 from node 42 at nominal priority: 0x107D552A), the tail byte, and the
// frames that aren't single-frame messages refused.
test("the Cyphal/CAN identifier and tail byte match the specification, compiled on this computer", { skip: gxx ? false : "needs g++" }, () => {
	const bin = join(tempDir(), "linkcyphal_test")
	execFileSync("g++", ["-std=c++17", "-Wall", "-Werror", "-I", join(ROOT, "test/fw-host"), "-I", join(ROOT, "templates/fw/include"), join(ROOT, "test/fw-host/linkcyphal_test.cpp"), "-o", bin])
	const r = spawnSync(bin, { encoding: "utf8" })
	for (const c of ["heartbeat-id", "tail", "parse", "not-ours"]) assert.match(r.stdout, new RegExp(`^PASS ${c}$`, "m"), r.stdout)
	assert.equal(r.status, 0, r.stdout)
})
