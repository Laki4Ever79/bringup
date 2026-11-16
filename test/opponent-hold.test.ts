// Under a competition's rules (motion.rules) the rover stops for the robot ahead and waits for it to leave
// (templates/fw-rover/src/rover_hold.h): the header gate, and the hold's logic built for the host.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { roverHeader, OPPONENT_GAP_MM } from "../src/mechanics/firmware.ts"
import { EUROBOT_BOARD, ROVER_BOARD } from "../src/inference/scripts.ts"
import { tempDir } from "./helpers.ts"

const snap = (b: unknown) => ({ revision: 1, versions: {} as never, values: JSON.parse(JSON.stringify(b)) })
const def = (h: string, name: string) => Number(new RegExp(`#define ${name} (\\d+)`).exec(h)?.[1])

test("the Eurobot base holds for the opponent, before its wall stop; the plain rover's header has no hold", () => {
	const h = roverHeader(snap(EUROBOT_BOARD))
	assert.ok(def(h, "ROVER_HOLD_MM") >= OPPONENT_GAP_MM, h)
	assert.ok(def(h, "ROVER_HOLD_MM") >= def(h, "ROVER_STOP_MM"), "the hold comes before the drive's turn away")
	assert.ok(def(h, "ROVER_CLEAR_MM") > def(h, "ROVER_HOLD_MM"))
	assert.doesNotMatch(roverHeader(snap(ROVER_BOARD)), /ROVER_HOLD|ROVER_CLEAR|ROVER_BLIND/)
})

const skip = spawnSync("g++", ["--version"]).status === 0 ? false : "no host g++"
test("the hold: stops when close, holds while it stays (also blind under 30 mm), lets go when it leaves, gives up on a wall", { skip }, () => {
	const dir = tempDir()
	const inc = resolve(import.meta.dirname, "../templates/fw-rover/src")
	writeFileSync(join(dir, "u.cpp"), `#include "rover_hold.h"
#include <cstdio>
#define H(d, t) rover_hold(h, d, t, 200, 250, 60, 5000)
#define CHECK(c) if (!(c)) { std::printf("FAIL line %d\\n", __LINE__); return 1; }
int main() {
	{ RoverHold h;  // the opponent comes, stands, leaves
		CHECK(!H(-1, 0)); CHECK(!H(400, 100)); CHECK(H(190, 200)); CHECK(H(185, 2000)); CHECK(H(230, 2100)); // between hold and clear: still holding
		CHECK(!H(260, 2200)); CHECK(!H(-1, 2300)); }
	{ RoverHold h;  // it leaves sideways: nothing in range after a reading above the blind range
		CHECK(H(180, 0)); CHECK(!H(-1, 100)); }
	{ RoverHold h;  // it comes right up to the sensor: no reading under the blind range is "still there"
		CHECK(H(150, 0)); CHECK(H(40, 100)); CHECK(H(-1, 200)); CHECK(H(-1, 3000)); }
	{ RoverHold h;  // a wall: after the longest hold the drive's own turn takes over, no new hold until it is clear
		CHECK(H(190, 0)); CHECK(H(190, 4999)); CHECK(!H(190, 5000)); CHECK(!H(150, 5100)); CHECK(!H(400, 5200)); CHECK(H(190, 5300)); }
	std::printf("ok\\n");
	return 0;
}`)
	execFileSync("g++", ["-std=c++17", "-Wall", "-Werror", "-I", inc, "-o", join(dir, "u"), join(dir, "u.cpp")])
	const r = spawnSync(join(dir, "u"), { encoding: "utf8" })
	assert.equal(r.status, 0, r.stdout)
})
