// Quadrature encoder counting, pure and host-tested (test/test_rover): with both channels of each wheel's encoder wired
// (ENC_LB/ENC_RB, an MCU with the pins: the ESP32-S3), the count's direction comes from the encoder, not from the duty
// last driven. The ESP32-S3 decodes in hardware (PCNT, hw_board.cpp); a chip without pulse counters steps quad_delta
// on every edge of either channel.
#pragma once
#include <stdint.h>

// One step of a quadrature signal: prev and cur are the two channels' levels (A in bit 1, B in bit 0). +1 or -1 for a
// step one way or the other, 0 for no change or a skipped state (both channels changed: direction unknown, not counted).
static inline int8_t quad_delta(uint8_t prev, uint8_t cur) {
	// Gray order 00 -> 01 -> 11 -> 10 -> 00 is one direction (+1), the reverse the other (-1).
	static const int8_t table[16] = {0, +1, -1, 0, -1, 0, 0, +1, +1, 0, 0, -1, 0, -1, +1, 0};
	return table[((prev & 3) << 2) | (cur & 3)];
}

// Which way a wheel's encoder counts against the duty: an encoder's phase against its motor's terminals, and how the
// board wires the motor, aren't known before the bench. The sign is learned once, from the first drive that moves the
// wheel QUAD_LEARN_COUNTS one way: then the count is positive forward (as rover_enc.h wants). Until then the raw count.
#define QUAD_LEARN_COUNTS 16
struct QuadSign {
	int8_t sign = 0; // 0: not learned yet
};
// raw: the decoder's count since power-up; duty: the last duty driven on that wheel (positive forward).
static inline int32_t quad_forward(QuadSign &q, int32_t raw, float duty) {
	if (q.sign == 0 && duty != 0.0f && (raw >= QUAD_LEARN_COUNTS || raw <= -QUAD_LEARN_COUNTS)) q.sign = ((raw > 0) == (duty > 0)) ? 1 : -1;
	return q.sign < 0 ? -raw : raw;
}
