// Odometry and go-to-point on the wheel encoders (templates/fw-rover/src/rover_odo.h): the header gate, and the logic
// built for the host against a kinematic robot.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { roverHeader } from "../src/mechanics/firmware.ts"
import { EUROBOT_BOARD, ROVER_BOARD } from "../src/inference/scripts.ts"
import { tempDir } from "./helpers.ts"

const snap = (b: unknown) => ({ revision: 1, versions: {} as never, values: JSON.parse(JSON.stringify(b)) })

test("a rover with encoders gets its odometry numbers; one without has none", () => {
	const h = roverHeader(snap(EUROBOT_BOARD))
	assert.match(h, /#define ROVER_MM_PER_COUNT 0\.\d+f/)
	assert.match(h, /#define ROVER_TRACK_MM 270\.0f/)
	assert.match(h, /#define ROVER_GOTO_MIN_DUTY 0\.\d+f/)
	assert.doesNotMatch(roverHeader(snap(ROVER_BOARD)), /ROVER_MM_PER_COUNT|ROVER_GOTO/)
})

const skip = spawnSync("g++", ["--version"]).status === 0 ? false : "no host g++"
test("odometry follows the wheels, and go-to-point reaches targets ahead, aside and behind within 8 mm", { skip }, () => {
	const dir = tempDir()
	writeFileSync(join(dir, "t.cpp"), `#include "rover_odo.h"
#include <cstdio>
#include <cmath>
#define CHECK(c) if (!(c)) { std::printf("FAIL line %d\\n", __LINE__); return 1; }
// A kinematic robot: each wheel's speed follows its duty (1.0 = 0.42 m/s), 33 ms ticks, 0.2782 mm a count, 270 mm track.
static int drive(float tx, float ty) {
	RoverOdo o; RoverGoto g; rover_goto_start(g, tx, ty);
	double x = 0, y = 0, th = 0, cl = 0, cr = 0;
	const double mpc = 0.2782, track = 270, dt = 0.033;
	for (int i = 0; i < 2000 && g.active; i++) {
		rover_odo_step(o, (int32_t)cl, (int32_t)cr, (float)mpc, (float)track);
		RoverOut u = rover_goto_step(g, o, 0.504f, 0.202f);
		const double vl = u.left * 420, vr = u.right * 420;  // mm/s
		const double ds = (vl + vr) / 2 * dt, dth = (vr - vl) / track * dt;
		x += ds * cos(th + dth / 2); y += ds * sin(th + dth / 2); th += dth;
		cl += vl * dt / mpc; cr += vr * dt / mpc;
	}
	const double miss = hypot(x - tx, y - ty);
	std::printf("target %.0f %.0f: miss %.1f mm, done %d\\n", tx, ty, miss, (int)g.done);
	return g.done && miss < 8.0 ? 0 : 1;
}
int main() {
	{ RoverOdo o; rover_odo_step(o, 0, 0, 0.5f, 200); rover_odo_step(o, 1000, 1000, 0.5f, 200);
		CHECK(fabsf(o.x - 500) < 0.01f && fabsf(o.y) < 0.01f && fabsf(o.th) < 1e-6f); }
	{ RoverOdo o; const float quarter = (float)M_PI / 2 * 100 / 0.5f;  // each wheel's counts for a quarter turn in place
		rover_odo_step(o, 0, 0, 0.5f, 200); rover_odo_step(o, (int32_t)-quarter, (int32_t)quarter, 0.5f, 200);
		CHECK(fabsf(o.th - (float)M_PI / 2) < 0.01f && hypotf(o.x, o.y) < 0.5f); }
	int bad = 0;
	bad += drive(600, 0); bad += drive(500, 300); bad += drive(0, -400); bad += drive(-300, 200); bad += drive(5, 3);
	CHECK(bad == 0);
	return 0;
}`)
	execFileSync("g++", ["-std=c++17", "-Wall", "-Werror", "-I", resolve(import.meta.dirname, "../templates/fw-rover/src"), "-o", join(dir, "t"), join(dir, "t.cpp")])
	const r = spawnSync(join(dir, "t"), { encoding: "utf8" })
	assert.equal(r.status, 0, r.stdout)
})
