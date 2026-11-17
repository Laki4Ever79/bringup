// The status LED under a match (PIN_START with PIN_STATUS_LED): one pattern per phase, so a referee or the team sees
// the robot's state from across the table. Pure: the board and the native test run it. Without a start cord the LED
// keeps main.cpp's 1 Hz heartbeat.
//   waiting for the cord: two short flashes every 2 s ("put the cord in")
//   ready (cord in, armed): steady on
//   running: fast blink, 4 Hz
//   stopped (the match is over): slow blink, 0.5 Hz
#pragma once
#include <stdint.h>
#include "match.h"

inline bool status_led(MatchPhase phase, uint32_t nowMs) {
	switch (phase) {
	case MATCH_WAIT_CORD: {
		const uint32_t t = nowMs % 2000;
		return t < 100 || (t >= 250 && t < 350);
	}
	case MATCH_ARMED:
		return true;
	case MATCH_RUNNING:
		return (nowMs / 125) % 2;
	case MATCH_OVER:
	default:
		return (nowMs / 1000) % 2;
	}
}
