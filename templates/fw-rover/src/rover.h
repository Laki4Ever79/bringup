// The rover's control logic: pure, no hardware calls, so the same code runs on the board, in QEMU (driving the
// MuJoCo model) and in the native unit test. Constants come from hw_pins.h (generated from the contract).
#pragma once
#include <stdint.h>

struct RoverConfig {
	int stopMm;      // closer than this: stop and turn away
	int slowMm;      // closer than this: slow down, linearly to the stop distance
	float cruise;    // duty at cruise speed (0..1)
	uint32_t turnMs; // how long a turn away lasts
};

struct RoverState {
	bool turning = false;
	uint32_t turnUntil = 0;
};

struct RoverOut {
	float left;
	float right;
};

// distanceMm: the front sensor's reading; -1 = nothing in range ahead (never "0 mm").
RoverOut rover_step(const RoverConfig &cfg, RoverState &st, int distanceMm, uint32_t nowMs);
