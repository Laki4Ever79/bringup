// The board's servo back end: the PCA9685 at 50 Hz on I2C, one channel per servo (include/arm.h ARM_CHANNEL), each
// joint's angle through its calibration offset (NVS, set over USB with "CAL <servo> <deg>") to the pulse.
#ifndef HW_SIM
#include <Arduino.h>
#include <Wire.h>
#include <Preferences.h>
#include "arm.h"
#include "arm_logic.h"
#include "servo_out.h"

static float cal[ARM_NS];
static uint32_t next = 0;

static void reg(uint8_t r, const uint8_t *b, int n) {
	Wire.beginTransmission(PCA9685_ADDR);
	Wire.write(r);
	for (int i = 0; i < n; i++) Wire.write(b[i]);
	Wire.endTransmission();
}

void servo_begin(void) {
	Preferences p;
	p.begin("arm", true);
	for (int i = 0; i < ARM_NS; i++) { char k[6] = {'c', 'a', 'l', (char)('0' + i), 0}; cal[i] = p.getFloat(k, 0); }
	p.end();
	Wire.begin(I2C_SDA, I2C_SCL);
	const uint8_t sleep = 0x10, prescale = arm_pca_prescale(ARM_SERVO_HZ), wake = 0x20, restart = 0xA0;  // AI on
	reg(0x00, &sleep, 1);       // MODE1: SLEEP, so PRE_SCALE takes
	reg(0xFE, &prescale, 1);    // PRE_SCALE
	reg(0x00, &wake, 1);        // awake, auto-increment
	delay(1);                   // the oscillator's 500 us
	reg(0x00, &restart, 1);
	next = millis();
}

void servo_write(int s, float j) {
	const float deg = arm_servo_deg(j, ARM_MIN_DEG[s], ARM_MAX_DEG[s], ARM_RANGE_DEG[s], cal[s]);
	uint8_t b[4];
	arm_pca_bytes(arm_pca_ticks(arm_pulse_us(deg, ARM_RANGE_DEG[s], ARM_PULSE_US[s][0], ARM_PULSE_US[s][1]), ARM_SERVO_HZ), b);
	reg(arm_pca_reg(ARM_CHANNEL[s]), b, 4);
}

// A "CAL <servo> <deg>" line on USB sets and keeps a servo's offset (the bench's calibration).
static void calibrate(void) {
	static char line[32];
	static int n = 0;
	while (Serial.available()) {
		const char c = (char)Serial.read();
		if (c != '\n' && n + 1 < (int)sizeof line) { line[n++] = c; continue; }
		line[n] = 0;
		n = 0;
		int s;
		float d;
		if (sscanf(line, "CAL %d %f", &s, &d) == 2 && s >= 0 && s < ARM_NS) {
			cal[s] = d;
			Preferences p;
			p.begin("arm", false);
			char k[6] = {'c', 'a', 'l', (char)('0' + s), 0};
			p.putFloat(k, d);
			p.end();
			Serial.printf("cal %d = %.1f deg\n", s, d);
		}
	}
}

uint32_t servo_flush(void) {
	calibrate();
	next += ARM_PERIOD_MS;
	const int32_t wait = (int32_t)(next - millis());
	if (wait > 0) delay(wait);
	return millis();
}

void servo_done(void) {}
#endif
