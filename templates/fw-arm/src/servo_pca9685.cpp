// The servo driver: the PCA9685 at 50 Hz on I2C, one channel per servo (include/arm.h ARM_CHANNEL), each joint's angle
// through its calibration offset (NVS, set over USB with "CAL <servo> <deg>") to the pulse. The same code in the board
// and the simulation builds: only the bus under it differs (link.h).
#include <Arduino.h>
#include <Preferences.h>
#include "arm.h"
#include "arm_logic.h"
#include "servo_out.h"
#include "link.h"

static float cal[ARM_NS];

static void reg(uint8_t r, const uint8_t *b, int n) {
	uint8_t buf[1 + 4];
	buf[0] = r;
	for (int i = 0; i < n && i < 4; i++) buf[1 + i] = b[i];
	link_i2c_write(PCA9685_ADDR, buf, 1 + (n < 4 ? n : 4));
}

void servo_begin(void) {
	Preferences p;
	p.begin("arm", true);
	for (int i = 0; i < ARM_NS; i++) { char k[6] = {'c', 'a', 'l', (char)('0' + i), 0}; cal[i] = p.getFloat(k, 0); }
	p.end();
	link_begin();
	const uint8_t sleep = 0x10, prescale = arm_pca_prescale(ARM_SERVO_HZ), wake = 0x20, restart = 0xA0;  // AI on
	reg(0x00, &sleep, 1);       // MODE1: SLEEP, so PRE_SCALE takes
	reg(0xFE, &prescale, 1);    // PRE_SCALE
	reg(0x00, &wake, 1);        // awake, auto-increment
	delay(1);                   // the oscillator's 500 us
	reg(0x00, &restart, 1);
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
	return link_tick(ARM_PERIOD_MS);
}

void servo_done(void) { link_end(); }
