// The rover's control logic with wheel encoders (an encoder gearmotor): rover.h's, with the turn ended on the wheels'
// counts, a back-off before it, and the straight held on the count difference. A separate unit, built in only when the
// header defines ROVER_TURN_COUNTS, so a rover without encoders runs exactly the code it always ran. Pure, as rover.cpp.
#pragma once
#include <stdint.h>
#include <math.h>
#include "rover.h"  // RoverOut

struct RoverEncConfig {
	int stopMm;      // closer than this: stop and turn away
	int slowMm;      // closer than this: slow down, linearly to the stop distance
	float cruise;    // duty at cruise speed (0..1)
	uint32_t turnMs; // how long a turn away lasts (with encoders: the turn's time limit is twice this)
	// With wheel encoders (0 without): the turn ends once each wheel has turned this many counts on average, and on the
	// straight the difference between the wheels' counts since the turn is held at zero, holdGain duty per count.
	int32_t turnCounts;
	float holdGain;
	// With wheel encoders: before turning in place it backs straight off this many counts along the way it came, which
	// takes it out of a corner it met at a shallow angle (its rear would sweep into the side wall the front sensor can't
	// see). 0: turn at once.
	int32_t backCounts;
	// With a gyro (an IMU on the board, 0 without): the turn ends once the heading has turned this many radians, whatever
	// the wheels counted (they slip in a turn in place). The time limit stays the fail-safe.
	float turnRad = 0;
	// Without encoders: the back-off before a turn in place lasts this long at cruise duty (0: turn at once).
	uint32_t backMs = 0;
	// Before a turn in place the motors stop for this long, so the robot pivots from rest. Spinning the wheels against
	// each other doesn't brake the body: the narrow rover turned at 0.13 m/s and slid 94 mm into the side wall during
	// the turn (22 Nov 2026). 0: turn at once.
	uint32_t restMs = 0;
};

struct RoverEncState {
	bool turning = false;
	bool backing = false;
	bool resting = false;
	uint32_t turnUntil = 0;
	int lastMm = -1; // the last reading since the last turn; -1 = none
	int32_t turnL = 0, turnR = 0;     // the encoders when the turn began
	int32_t straightL = 0, straightR = 0; // the encoders when the straight began
	float turnHeading = 0;                // the heading when the turn began (with a gyro)
};

// distanceMm: the front sensor's reading; -1 = no reading. No reading is "nothing ahead", except right after a reading
// inside the slow-down distance: the VL53L0X can't measure under about 30 mm, so an obstacle that close may read as
// nothing. Then it turns away (fail-safe); after a turn the view has changed, and no reading means nothing ahead again.
// encL, encR: the wheels' encoder counts, positive forward (0 without encoders).
// headingRad: the gyro's heading (radians, counter-clockwise); NAN without one, and then the turn closes on the counts.
RoverOut rover_enc_step(const RoverEncConfig &cfg, RoverEncState &st, int distanceMm, uint32_t nowMs, int32_t encL, int32_t encR, float headingRad = NAN);
