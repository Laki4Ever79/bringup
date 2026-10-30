// Bringup firmware template. include/pins.h is generated from the design contract.
#include <Arduino.h>
#include <Wire.h>
#include "pins.h"

#if defined(PIN_I2C_SDA) && defined(PIN_I2C_SCL)
static_assert(PIN_I2C_SDA >= 0 && PIN_I2C_SDA < SOC_GPIO_PIN_COUNT, "PIN_I2C_SDA is not a GPIO on this chip");
static_assert(PIN_I2C_SCL >= 0 && PIN_I2C_SCL < SOC_GPIO_PIN_COUNT, "PIN_I2C_SCL is not a GPIO on this chip");
#define HAS_I2C 1
#endif

#ifdef PIN_STATUS_LED
static_assert(PIN_STATUS_LED >= 0 && PIN_STATUS_LED < SOC_GPIO_PIN_COUNT, "PIN_STATUS_LED is not a GPIO on this chip");
#define HAS_LED 1
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

// The LED's anode is on the GPIO and its cathode goes to GND through a resistor, so HIGH is on.
static void led(bool on) {
#ifdef HAS_LED
	digitalWrite(PIN_STATUS_LED, on ? HIGH : LOW);
#endif
}

// One 2 s reading period: a steady 1 Hz blink while the sensor answers, a double blink when it doesn't.
static void blinkPeriod(bool sensorOk) {
	if (sensorOk) {
		for (int i = 0; i < 2; i++) { led(true); delay(500); led(false); delay(500); }
	} else {
		for (int i = 0; i < 2; i++) { led(true); delay(100); led(false); delay(150); }
		delay(1500);
	}
}

void setup() {
	Serial.begin(115200);
	Serial.printf("bringup rev %d\n", BRINGUP_REVISION);
#ifdef HAS_I2C
	Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
#endif
#ifdef HAS_LED
	pinMode(PIN_STATUS_LED, OUTPUT);
#endif
}

void loop() {
	float t, rh;
	bool ok = readSht40(&t, &rh);
	if (ok) Serial.printf("SENSOR OK %.2f C %.1f %%RH\n", t, rh);
	else Serial.println("SENSOR FAIL");
	blinkPeriod(ok);
}
