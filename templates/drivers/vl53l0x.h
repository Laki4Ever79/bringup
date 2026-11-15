// What the rover makes of one VL53L0X reading (Pololu's library does the I2C): a timeout, or a range at or past the
// sensor's useful range (8190 is the library's "no target"), is "nothing in range", -1, as the control loop expects.
#pragma once

static inline int tofDistanceMm(int raw, bool timedOut, int rangeMm) {
	if (timedOut || raw < 0 || raw >= rangeMm) return -1;
	return raw;
}
