// The PCA9685 16-channel PWM driver (NXP datasheet PCA9685, rev 4): a robot's servos and a spare motor's inputs on
// the I2C bus when the MCU has no pins left. The arithmetic is pure (the native test runs it); main.cpp writes the bytes.
//   prescale = round(25 MHz / (4096 x update rate)) - 1 (7.3.5), so 121 for servos' 50 Hz
//   a channel's OFF count = pulse width / period x 4096 (ON at 0)
//   registers: MODE1 0x00 (SLEEP bit 4, AI bit 5, RESTART bit 7), PRE_SCALE 0xFE (writable only asleep), LEDn_ON_L at
//   0x06 + 4n, then ON_H, OFF_L, OFF_H; bit 4 of ON_H / OFF_H is "full on" / "full off".
#pragma once
#include <stdint.h>

#define PCA9685_OSC_HZ 25000000UL
#define PCA9685_MODE1 0x00
#define PCA9685_PRESCALE 0xFE
#define PCA9685_LED0 0x06

inline uint8_t pca9685_prescale(uint32_t hz) {
	const uint32_t v = (PCA9685_OSC_HZ + 2048UL * hz) / (4096UL * hz);  // round(osc / (4096 hz))
	return (uint8_t)(v < 4 ? 3 : v - 1);  // the chip forces at least 3
}
// The OFF count for a pulse of `us` microseconds at `hz`: what a servo reads (1000-2000 us, 1500 centre).
inline uint16_t pca9685_ticks_us(uint32_t us, uint32_t hz) {
	const uint32_t t = (uint32_t)(((uint64_t)us * 4096UL * hz + 500000UL) / 1000000UL);
	return (uint16_t)(t > 4095 ? 4095 : t);
}
// A channel's four register bytes for a duty in 0..1 (0 = full off, 1 = full on), ON at count 0.
inline void pca9685_duty_bytes(float duty, uint8_t out[4]) {
	if (duty <= 0) { out[0] = 0; out[1] = 0; out[2] = 0; out[3] = 0x10; return; }
	if (duty >= 1) { out[0] = 0; out[1] = 0x10; out[2] = 0; out[3] = 0; return; }
	const uint16_t off = (uint16_t)(duty * 4096.0f + 0.5f);
	out[0] = 0; out[1] = 0; out[2] = (uint8_t)(off & 0xFF); out[3] = (uint8_t)(off >> 8);
}
// The spare motor (DRV8833 channel A on two PCA9685 channels, slow decay off): -1..1 to the two inputs' duties.
inline void pca9685_motor(float d, float &in1, float &in2) {
	if (d > 1) d = 1;
	if (d < -1) d = -1;
	in1 = d > 0 ? d : 0;
	in2 = d < 0 ? -d : 0;
}
