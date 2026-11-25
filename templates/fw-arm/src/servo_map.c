// Joint angle → servo angle → pulse → PCA9685 bytes (NXP PCA9685 datasheet rev 4: prescale 7.3.5, LEDn registers 7.3.3).
#include "arm_logic.h"

float arm_servo_deg(float j, float minDeg, float maxDeg, float rangeDeg, float cal) {
	float s = j - minDeg + (rangeDeg - (maxDeg - minDeg)) / 2 + cal;
	return s < 0 ? 0 : s > rangeDeg ? rangeDeg : s;
}

uint16_t arm_pulse_us(float s, float rangeDeg, uint16_t us0, uint16_t us1) {
	return (uint16_t)(us0 + (us1 - us0) * (s / rangeDeg) + 0.5f);
}

uint8_t arm_pca_prescale(uint32_t hz) {
	const uint32_t v = (25000000UL + 2048UL * hz) / (4096UL * hz);  // round(25 MHz / (4096 x hz))
	return (uint8_t)(v < 4 ? 3 : v - 1);
}

uint16_t arm_pca_ticks(uint32_t us, uint32_t hz) {
	const uint32_t t = (uint32_t)(((uint64_t)us * 4096UL * hz + 500000UL) / 1000000UL);
	return (uint16_t)(t > 4095 ? 4095 : t);
}

void arm_pca_bytes(uint16_t off, uint8_t out[4]) {
	out[0] = 0; out[1] = 0; out[2] = (uint8_t)(off & 0xFF); out[3] = (uint8_t)((off >> 8) & 0x0F);
}

uint8_t arm_pca_reg(uint8_t ch) { return (uint8_t)(0x06 + 4 * ch); }
