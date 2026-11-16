// Under a competition's rules (motion.rules: Eurobot), the rover stops for what is ahead and waits for it to leave
// instead of turning away: the opponent's robot. Pure, no hardware calls: the board, QEMU and the native test run it.
// Included only when hw_pins.h defines ROVER_HOLD_MM, so a rover with no rules builds as before.
#pragma once
#include <stdint.h>

struct RoverHold {
	bool on = false;      // holding: both motors stopped
	bool expired = false; // held for the longest wait: what is ahead doesn't move (a wall), the drive's own turn takes over
	uint32_t since = 0;
	int last = -1;        // the last reading; -1 = none yet
};

// holdMm: closer than this, stop. clearMm: a reading this far or more (or nothing in range after a far reading) means
// it left. blindMm: under this the sensor reads nothing (VL53L0X, about 30 mm), so no reading right after one this close
// means it is still there. maxMs: the longest hold before treating what is ahead as fixed.
inline bool rover_hold(RoverHold &h, int d, uint32_t now, int holdMm, int clearMm, int blindMm, uint32_t maxMs) {
	const int prev = h.last;
	if (d >= 0) h.last = d;
	if (h.expired) {
		// The drive turned away or what was ahead left: the next obstacle holds again.
		if (d < 0 || d >= clearMm) h.expired = false;
		return false;
	}
	if (!h.on) {
		if (d >= 0 && d < holdMm) {
			h.on = true;
			h.since = now;
		}
		return h.on;
	}
	const bool gone = d >= 0 ? d >= clearMm : !(prev >= 0 && prev < blindMm);
	if (gone) {
		h.on = false;
		return false;
	}
	if ((uint32_t)(now - h.since) >= maxMs) {
		h.on = false;
		h.expired = true;
		return false;
	}
	return true;
}
