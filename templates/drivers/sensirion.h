// Sensirion temperature/humidity sensors, one driver for every firmware that reads one (the product firmware and the
// rover's payload). Plain Arduino Wire; the host tests (host/drivertest.cpp) run this same file against simulated chips.
//
//   SHT4x  datasheet: I2C 0x44; 0xFD measures T and RH at high repeatability, at most 8.3 ms; 6 bytes back
//          (T msb, lsb, CRC, RH msb, lsb, CRC). T = -45 + 175·S/(2^16-1) °C, RH = -6 + 125·S/(2^16-1) %, cropped to 0..100 as the datasheet advises.
//   SHTC3  datasheet v4: I2C 0x70; wakeup 0x3517 (up to 240 µs), measure T first, normal mode, no clock stretching
//          0x7866 (up to 12.1 ms), sleep 0xB098. T = -45 + 175·S/2^16 °C, RH = 100·S/2^16 %.
//   CRC-8  polynomial 0x31, init 0xFF (both datasheets; 0xBEEF → 0x92).
#pragma once
#include <Arduino.h>
#include <Wire.h>
#include <stdint.h>

static const uint8_t SHT4X_ADDR = 0x44;
static const uint8_t SHT4X_MEASURE_HIGH = 0xFD;
static const uint32_t SHT4X_MEASURE_MS = 10;  // 8.3 ms at most, plus margin
static const uint8_t SHTC3_ADDR = 0x70;
static const uint16_t SHTC3_WAKEUP = 0x3517, SHTC3_MEASURE = 0x7866, SHTC3_SLEEP = 0xB098;
static const uint32_t SHTC3_WAKE_US = 240;
static const uint32_t SHTC3_MEASURE_MS = 13;  // 12.1 ms at most

static inline uint8_t crc8(const uint8_t *data, int len) {
	uint8_t crc = 0xFF;
	for (int i = 0; i < len; i++) {
		crc ^= data[i];
		for (int b = 0; b < 8; b++) crc = (crc & 0x80) ? (crc << 1) ^ 0x31 : crc << 1;
	}
	return crc;
}

// The 6 bytes a measurement returns, CRC-checked: false when either word's CRC is wrong.
static inline bool sensirionRead6(uint8_t addr, uint16_t *rawT, uint16_t *rawRh) {
	uint8_t buf[6];
	if (Wire.requestFrom(addr, (uint8_t)6) != 6) return false;
	for (int i = 0; i < 6; i++) buf[i] = Wire.read();
	if (crc8(buf, 2) != buf[2] || crc8(buf + 3, 2) != buf[5]) return false;
	*rawT = (uint16_t)(buf[0] << 8 | buf[1]);
	*rawRh = (uint16_t)(buf[3] << 8 | buf[4]);
	return true;
}

static inline float cropRh(float rh) { return rh < 0 ? 0 : rh > 100 ? 100 : rh; }

static inline bool sht4xRead(float *tempC, float *rh) {
	Wire.beginTransmission(SHT4X_ADDR);
	Wire.write(SHT4X_MEASURE_HIGH);
	if (Wire.endTransmission() != 0) return false;
	delay(SHT4X_MEASURE_MS);
	uint16_t t, h;
	if (!sensirionRead6(SHT4X_ADDR, &t, &h)) return false;
	*tempC = -45 + 175 * (t / 65535.0f);
	*rh = cropRh(-6 + 125 * (h / 65535.0f));
	return true;
}

static inline bool shtc3Command(uint16_t cmd) {
	Wire.beginTransmission(SHTC3_ADDR);
	Wire.write((uint8_t)(cmd >> 8));
	Wire.write((uint8_t)(cmd & 0xFF));
	return Wire.endTransmission() == 0;
}

// Wakes the SHTC3, measures and puts it back to sleep (0.3 µA), whether the reading succeeded or not.
static inline bool shtc3Read(float *tempC, float *rh) {
	if (!shtc3Command(SHTC3_WAKEUP)) return false;
	delayMicroseconds(SHTC3_WAKE_US);
	if (!shtc3Command(SHTC3_MEASURE)) {
		shtc3Command(SHTC3_SLEEP);
		return false;
	}
	delay(SHTC3_MEASURE_MS);
	uint16_t t, h;
	const bool ok = sensirionRead6(SHTC3_ADDR, &t, &h);
	shtc3Command(SHTC3_SLEEP);
	if (!ok) return false;
	*tempC = -45 + 175 * (t / 65536.0f);
	*rh = 100 * (h / 65536.0f);
	return true;
}
