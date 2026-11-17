// The PCA9685 driver's arithmetic (templates/fw-rover/src/pca9685.h) against NXP's datasheet: the prescaler (7.3.5:
// 200 Hz gives the reset value 0x1E), a servo's pulse in counts, full on/off bits, and the spare motor's inputs.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tempDir } from "./helpers.ts"

const skip = spawnSync("g++", ["--version"]).status === 0 ? false : "no host g++"
test("PCA9685: prescaler, servo counts, full on/off and the motor's two inputs", { skip }, () => {
	const dir = tempDir()
	writeFileSync(join(dir, "t.cpp"), `#include "pca9685.h"
#include <cstdio>
#define CHECK(c) if (!(c)) { std::printf("FAIL line %d\\n", __LINE__); return 1; }
int main() {
	CHECK(pca9685_prescale(200) == 30);   // the datasheet's example: 0x1E, the reset value
	CHECK(pca9685_prescale(50) == 121);
	CHECK(pca9685_prescale(5000) == 3);   // the chip's floor
	CHECK(pca9685_ticks_us(1500, 50) == 307);
	CHECK(pca9685_ticks_us(1000, 50) == 205 && pca9685_ticks_us(2000, 50) == 410);
	uint8_t b[4];
	pca9685_duty_bytes(0, b); CHECK(b[3] == 0x10 && b[1] == 0);
	pca9685_duty_bytes(1, b); CHECK(b[1] == 0x10 && b[3] == 0);
	pca9685_duty_bytes(0.5f, b); CHECK(b[2] == 0x00 && b[3] == 0x08);  // 2048
	float a, c; pca9685_motor(0.4f, a, c); CHECK(a > 0.39f && c == 0);
	pca9685_motor(-2, a, c); CHECK(a == 0 && c == 1);
	std::printf("ok\\n");
	return 0;
}`)
	execFileSync("g++", ["-std=c++17", "-Wall", "-Werror", "-I", resolve(import.meta.dirname, "../templates/fw-rover/src"), "-o", join(dir, "t"), join(dir, "t.cpp")])
	const r = spawnSync(join(dir, "t"), { encoding: "utf8" })
	assert.equal(r.status, 0, r.stdout)
})
