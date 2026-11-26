// The board's link: the PCA9685 on Wire (include/arm.h I2C_SDA/I2C_SCL), ticks paced by millis().
#ifndef HW_SIM
#include <Arduino.h>
#include <Wire.h>
#include "arm.h"
#include "link.h"

static uint32_t next = 0;

void link_begin(void) {
	Wire.begin(I2C_SDA, I2C_SCL);
	next = millis();
}

void link_i2c_write(uint8_t addr, const uint8_t *b, int n) {
	Wire.beginTransmission(addr);
	for (int i = 0; i < n; i++) Wire.write(b[i]);
	Wire.endTransmission();
}

uint32_t link_tick(uint32_t periodMs) {
	next += periodMs;
	const int32_t wait = (int32_t)(next - millis());
	if (wait > 0) delay(wait);
	return millis();
}

void link_end(void) {}
#endif
