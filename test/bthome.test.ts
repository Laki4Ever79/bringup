import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// The firmware's own BTHome encoder (templates/fw/include/bthome.h), compiled on the host and checked against the
// examples on bthome.io/format.
const header = resolve(import.meta.dirname, "../templates/fw/include/bthome.h")
const skip = spawnSync("g++", ["--version"]).status === 0 ? false : "no host g++"

function encode(cases: [number, boolean, number, number][]): string[] {
	const dir = mkdtempSync(join(tmpdir(), "bthome-"))
	const calls = cases.map(([pid, has, t, h]) => `print(${pid}, ${has}, (float)(${t}), (float)(${h}));`).join("\n")
	writeFileSync(join(dir, "t.cpp"), `#include "${header}"\n#include <stdio.h>\nstatic void print(int p, bool c, float t, float h) { uint8_t b[16]; size_t n = bthomeServiceData(b, p, c, t, h); for (size_t i = 0; i < n; i++) printf("%02X", b[i]); printf("\\n"); }\nint main() {\n${calls}\n}\n`)
	execFileSync("g++", ["-std=c++17", "-Wall", "-Werror", "-o", join(dir, "t"), join(dir, "t.cpp")])
	return execFileSync(join(dir, "t"), { encoding: "utf8" }).trim().split("\n")
}

test("BTHome service data matches the spec's examples byte for byte", { skip }, () => {
	const [example, temp, pid, none, cold] = encode([
		[-1, true, 25.0, 50.55], // bthome.io/format's full example: 0A16D2FC 40 02C409 03BF13
		[-1, true, 25.06, 50.55], // the temperature row's example: 02CA09
		[9, true, 25.0, 50.55], // packet id first (lowest object id): 0009
		[9, false, 0, 0], // no reading: the packet id alone
		[-1, true, -12.34, 0], // below zero: sint16
	])
	assert.equal(example, "4002C40903BF13")
	assert.equal(temp, "4002CA0903BF13")
	assert.equal(pid, "40000902C40903BF13")
	assert.equal(none, "400009")
	assert.equal(cold, "40022EFB030000") // -1234 = 0xFB2E, little-endian
})
