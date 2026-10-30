// Bringup firmware template. include/pins.h is generated from the design contract.
#include <Arduino.h>
#include <Wire.h>
#include "pins.h"

#if defined(PIN_I2C_SDA) && defined(PIN_I2C_SCL)
static_assert(PIN_I2C_SDA >= 0 && PIN_I2C_SDA < SOC_GPIO_PIN_COUNT, "PIN_I2C_SDA is not a GPIO on this chip");
static_assert(PIN_I2C_SCL >= 0 && PIN_I2C_SCL < SOC_GPIO_PIN_COUNT, "PIN_I2C_SCL is not a GPIO on this chip");
#define HAS_I2C 1
#endif

static const uint8_t SHT40_ADDR = 0x44;
static const uint8_t SHT40_MEASURE_HIGH = 0xFD;

// Sensirion CRC-8: polynomial 0x31, init 0xFF.
static uint8_t crc8(const uint8_t *data, int len) {
	uint8_t crc = 0xFF;
	for (int i = 0; i < len; i++) {
		crc ^= data[i];
		for (int b = 0; b < 8; b++) crc = (crc & 0x80) ? (crc << 1) ^ 0x31 : crc << 1;
	}
	return crc;
}

static bool readSht40(float *tempC, float *rh) {
#ifdef HAS_I2C
	Wire.beginTransmission(SHT40_ADDR);
	Wire.write(SHT40_MEASURE_HIGH);
	if (Wire.endTransmission() != 0) return false;
	delay(10);
	uint8_t buf[6];
	if (Wire.requestFrom(SHT40_ADDR, (uint8_t)6) != 6) return false;
	for (int i = 0; i < 6; i++) buf[i] = Wire.read();
	if (crc8(buf, 2) != buf[2] || crc8(buf + 3, 2) != buf[5]) return false;
	*tempC = -45 + 175 * ((buf[0] << 8 | buf[1]) / 65535.0f);
	*rh = -6 + 125 * ((buf[3] << 8 | buf[4]) / 65535.0f);
	return true;
#else
	return false;
#endif
}

void setup() {
	Serial.begin(115200);
	Serial.printf("bringup rev %d\n", BRINGUP_REVISION);
#ifdef HAS_I2C
	Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
#endif
}

void loop() {
	float t, rh;
	if (readSht40(&t, &rh)) Serial.printf("SENSOR OK %.2f C %.1f %%RH\n", t, rh);
	else Serial.println("SENSOR FAIL");
	delay(2000);
}
