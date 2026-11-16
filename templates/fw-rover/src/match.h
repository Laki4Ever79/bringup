// The match: a pull-cord start and a timed end (Eurobot General Rules 1.2 F.6 "Starting cord", H.3 "End of match").
// Pure logic, no hardware calls: the board, the simulation and the native unit test run the same code.
// The cord ends in a plug with a wire loop that shorts the board's START pin to GND while it is in. The robot arms only
// once it has seen the cord in (a robot powered up without its cord never starts on its own), starts once the cord has
// stayed out for MATCH_DEBOUNCE_MS, drives for the match, then stops every motor for good.
#pragma once
#include <stdint.h>

enum MatchPhase { MATCH_WAIT_CORD, MATCH_ARMED, MATCH_RUNNING, MATCH_OVER };

struct MatchState {
	MatchPhase phase = MATCH_WAIT_CORD;
	uint32_t outSince = 0; // when the cord was first seen out, while armed
	bool out = false;
	uint32_t startedAt = 0;
};

#define MATCH_DEBOUNCE_MS 50

// cordIn: the START pin reads low (the cord's loop is in). Returns true while the robot may drive.
bool match_step(MatchState &st, bool cordIn, uint32_t nowMs, uint32_t matchMs);
