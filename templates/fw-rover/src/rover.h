// The rover's control logic: pure, no hardware calls, so the same code runs on the board, in QEMU (driving the
// MuJoCo model) and in the native unit test. Constants come from hw_pins.h (generated from the contract).
#pragma once
#include <stdint.h>

struct RoverConfig {
	int stopMm;      // closer than this: stop and turn away
	int slowMm;      // closer than this: slow down, linearly to the stop distance
	float cruise;    // duty at cruise speed (0..1)
	uint32_t turnMs; // how long a turn away lasts (with encoders: the turn's time limit is twice this)
	// With wheel encoders (0 without): the turn ends once each wheel has turned this many counts on average, and on the
	// straight the difference between the wheels' counts since the turn is held at zero, holdGain duty per count.
	int32_t turnCounts;
	float holdGain;
};

struct RoverState {
	bool turning = false;
	uint32_t turnUntil = 0;
	int lastMm = -1; // the last reading since the last turn; -1 = none
	int32_t turnL = 0, turnR = 0;     // the encoders when the turn began
	int32_t straightL = 0, straightR = 0; // the encoders when the straight began
};

struct RoverOut {
	float left;
	float right;
};

// distanceMm: the front sensor's reading; -1 = no reading. No reading is "nothing ahead", except right after a reading
// inside the slow-down distance: the VL53L0X can't measure under about 30 mm, so an obstacle that close may read as
// nothing. Then it turns away (fail-safe); after a turn the view has changed, and no reading means nothing ahead again.
// encL, encR: the wheels' encoder counts, positive forward (0 without encoders).
RoverOut rover_step(const RoverConfig &cfg, RoverState &st, int distanceMm, uint32_t nowMs, int32_t encL = 0, int32_t encR = 0);
