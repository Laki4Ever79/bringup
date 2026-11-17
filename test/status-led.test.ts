// The status LED under a match (templates/fw-rover/src/status_led.h): ready, running and stopped look different.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tempDir } from "./helpers.ts"

const skip = spawnSync("g++", ["--version"]).status === 0 ? false : "no host g++"
test("each match phase has its own pattern over 2 s", { skip }, () => {
	const dir = tempDir()
	writeFileSync(join(dir, "t.cpp"), `#include "status_led.h"
#include <cstdio>
int main() {
	const MatchPhase ph[] = {MATCH_WAIT_CORD, MATCH_ARMED, MATCH_RUNNING, MATCH_OVER};
	for (auto p : ph) { int on = 0, edges = 0; bool last = status_led(p, 0); for (uint32_t t = 0; t < 2000; t += 5) { bool v = status_led(p, t); on += v; edges += v != last; last = v; } std::printf("%d %d\\n", on, edges); }
	return 0;
}`)
	execFileSync("g++", ["-std=c++17", "-Wall", "-Werror", "-I", resolve(import.meta.dirname, "../templates/fw-rover/src"), "-o", join(dir, "t"), join(dir, "t.cpp")])
	const rows = spawnSync(join(dir, "t"), { encoding: "utf8" }).stdout.trim().split("\n").map((l) => l.split(" ").map(Number))
	const [wait, ready, running, over] = rows
	assert.equal(ready[0], 400, "ready: steady on")
	assert.ok(running[1] >= 14, `running: fast (${running[1]} edges)`)
	assert.ok(over[1] <= 2 && over[0] > 0, "stopped: slow")
	assert.ok(wait[0] < 60 && wait[1] === 3, `waiting: two short flashes (${wait})`)
	assert.equal(new Set(rows.map((r) => r.join())).size, 4, "four distinct patterns")
})
