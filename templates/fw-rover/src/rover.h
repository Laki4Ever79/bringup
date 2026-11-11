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
	int lastMm = -1; // the last reading since the last turn; -1 = none
};

struct RoverOut {
	float left;
	float right;
};

// distanceMm: the front sensor's reading; -1 = no reading. No reading is "nothing ahead", except right after a reading
// inside the slow-down distance: the VL53L0X can't measure under about 30 mm, so an obstacle that close may read as
// nothing. Then it turns away (fail-safe); after a turn the view has changed, and no reading means nothing ahead again.
RoverOut rover_step(const RoverConfig &cfg, RoverState &st, int distanceMm, uint32_t nowMs);
