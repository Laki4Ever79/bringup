// The spindle's stall stop (src/cnc/stall.ts): its numbers from the board and the catalog, and its detector, compiled
// with the host's C compiler and driven through a run, a stall, a cut's brief load step, a stall at low duty, and a
// stall at the full brick current.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { CNC_DESIGN, CNC_MACHINE, CNC_TARGETS } from "../src/inference/scripts.ts"
import { adcChannel, stallHeader, stallParams, stallPlugin } from "../src/cnc/stall.ts"
import { defaultCheckCatalog } from "../src/mechanics/checks.ts"
import { fixtureContract } from "./fixture.ts"

const cnc = () => {
	const b = fixtureContract()
	return { ...b, values: { ...b.values, ...CNC_DESIGN, cncTargets: CNC_TARGETS, cnc: CNC_MACHINE } } as typeof b
}
const gcc = spawnSync("gcc", ["--version"]).status === 0

test("the stall stop's numbers: 6.0 A (twice the 3.1 A run current, held under 0.9 of the 6.67 A brick) for 300 ms, on PA5 = ADC1 channel 5", () => {
	const p = stallParams(cnc(), defaultCheckCatalog()!)!
	assert.deepEqual({ a: p.thresholdA, ms: p.holdMs, pin: p.pin, ch: p.adcChannel, gain: p.gainVV, shunt: p.shuntOhm }, { a: 6, ms: 300, pin: "PA5", ch: 5, gain: 20, shunt: 0.01 })
	assert.deepEqual([adcChannel("PA0"), adcChannel("PA7"), adcChannel("PB1"), adcChannel("PC5"), adcChannel("PA8")], [0, 7, 9, 15, null])
	const c = stallPlugin(p)
	for (const x of ["void my_plugin_init (void)", "grbl.on_execute_realtime = stall_poll;", "ADC_CHANNEL_5", "GPIO_PIN_5", "system_raise_alarm(Alarm_Spindle);"]) assert.ok(c.includes(x), x)
	assert.match(stallHeader(p), /#define STALL_THRESHOLD_A 6\.0f/, "a C float literal, not 6f")
})

test("the detector trips on a held stall and only then (compiled with the host's C compiler)", { skip: gcc ? false : "no host C compiler" }, () => {
	const p = stallParams(cnc(), defaultCheckCatalog()!)!
	const dir = mkdtempSync(join(tmpdir(), "stall-"))
	try {
		writeFileSync(join(dir, "bringup_stall.h"), stallHeader(p))
		// Each case: the motor's current (A) through the 20 V/V amplifier on 10 mOhm, at a PWM duty, sampled each ms; the
		// shunt sees it only during the on time, so the amplifier's average is the motor current times the duty.
		writeFileSync(join(dir, "t.c"), `#include <stdio.h>
#include "bringup_stall.h"
static int run (float motor_a, float duty, int ms, int spike_ms, float spike_a) {
    bringup_stall_t s = {0};
    for(int t = 0; t < ms; t++) {
        float a = (t >= 100 && t < 100 + spike_ms) ? spike_a : motor_a;
        if(bringup_stall_update(&s, a * duty * STALL_GAIN_VV * STALL_SHUNT_OHM, duty, 1)) return t;
    }
    return -1;
}
int main (void) {
    printf("%d %d %d %d %d\\n",
        run(3.1f, 0.6f, 2000, 0, 0.0f),     // running: never
        run(6.5f, 0.6f, 2000, 0, 0.0f),     // stalled: trips
        run(3.1f, 0.6f, 2000, 150, 7.0f),   // a 150 ms load step: under the hold, never
        run(6.5f, 0.05f, 2000, 0, 0.0f),    // at 5 % duty: not judged
        run(6.67f, 1.0f, 2000, 0, 0.0f));   // a stall at full duty, the brick's current: trips
    return 0;
}
`)
		const cc = spawnSync("gcc", ["-std=c11", "-Wall", "-Werror", "-O2", "-o", join(dir, "t"), join(dir, "t.c")], { encoding: "utf8" })
		assert.equal(cc.status, 0, cc.stderr)
		const [running, stalled, step, lowDuty, full] = spawnSync(join(dir, "t"), { encoding: "utf8" }).stdout.trim().split(" ").map(Number)
		assert.equal(running, -1, "running never trips")
		assert.equal(lowDuty, -1, "low duty isn't judged")
		assert.equal(step, -1, "a load step shorter than the hold doesn't trip")
		// Tripped within the hold plus the average's settling (STALL_AVG_MS ~ 20 ms to reach the threshold).
		assert.ok(stalled >= p.holdMs && stalled < p.holdMs + 100, `stalled: ${stalled} ms`)
		assert.ok(full >= p.holdMs && full < p.holdMs + 100, `full: ${full} ms`)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
