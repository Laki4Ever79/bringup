// LSM6DS3TR-C 6-axis IMU, the gyro's yaw rate for a robot's heading (catalog role imu). Plain Arduino Wire; the host
// tests (host/drivertest.cpp) run this same file against a simulated chip. ST DocID030071 Rev 3:
//   I2C 0x6A with SA0 low (6.1.1); WHO_AM_I (0Fh) reads 0x6A (Table 49).
//   CTRL3_C (12h) = 0x44: BDU (the two bytes of a reading from the same sample) and IF_INC (address auto-increment,
//   the default) (Table 57).
//   CTRL2_G (11h) = 0x44: ODR_G 0100 = 104 Hz, FS_G 01 = +/-500 dps (Tables 54, 55).
//   OUTZ_L_G/OUTZ_H_G (26h/27h): the yaw rate, two's complement, 17.5 mdps/LSB at +/-500 dps (Table 3, G_So).
//   Turn-on time 35 ms (Table 4, Ton).
#pragma once
#include <Arduino.h>
#include <Wire.h>
#include <stdint.h>
#include <math.h>

static const uint8_t LSM6_ADDR = 0x6A;
static const uint8_t LSM6_WHO_AM_I = 0x0F, LSM6_WHO = 0x6A;
static const uint8_t LSM6_CTRL2_G = 0x11, LSM6_CTRL3_C = 0x12, LSM6_OUTZ_L_G = 0x26;
static const uint8_t LSM6_GYRO_104HZ_500DPS = 0x44, LSM6_BDU_IFINC = 0x44;
static const float LSM6_DPS_PER_LSB = 0.0175f;
static const uint32_t LSM6_TURN_ON_MS = 35;

static inline bool lsm6Write(uint8_t reg, uint8_t v) {
	Wire.beginTransmission(LSM6_ADDR);
	Wire.write(reg);
	Wire.write(v);
	return Wire.endTransmission() == 0;
}
static inline bool lsm6Read(uint8_t reg, uint8_t *buf, uint8_t n) {
	Wire.beginTransmission(LSM6_ADDR);
	Wire.write(reg);
	if (Wire.endTransmission(false) != 0) return false;
	if (Wire.requestFrom(LSM6_ADDR, n) != n) return false;
	for (uint8_t i = 0; i < n; i++) buf[i] = (uint8_t)Wire.read();
	return true;
}

// The chip answers as an LSM6DS3TR-C and its gyro runs: false when it is absent or another chip answers.
static inline bool lsm6Begin(void) {
	uint8_t who = 0;
	if (!lsm6Read(LSM6_WHO_AM_I, &who, 1) || who != LSM6_WHO) return false;
	if (!lsm6Write(LSM6_CTRL3_C, LSM6_BDU_IFINC) || !lsm6Write(LSM6_CTRL2_G, LSM6_GYRO_104HZ_500DPS)) return false;
	delay(LSM6_TURN_ON_MS);
	return true;
}

// The yaw rate in degrees per second, counter-clockwise positive seen from above (the chip's Z up, Figure 1).
static inline bool lsm6YawDps(float *dps) {
	uint8_t b[2];
	if (!lsm6Read(LSM6_OUTZ_L_G, b, 2)) return false;
	*dps = (float)(int16_t)((uint16_t)b[1] << 8 | b[0]) * LSM6_DPS_PER_LSB;
	return true;
}

// The heading from the yaw rate: the rate's bias measured while the robot stands still at power-up (biasSamples
// readings), then integrated. Pure: the host tests drive it with a fake clock.
struct GyroHeading {
	float biasDps = 0;
	float rad = 0;
	uint32_t lastUs = 0;
	bool started = false;
};
static inline void gyroHeadingStep(GyroHeading &h, float dps, uint32_t nowUs) {
	if (h.started) {
		const float dt = (float)(uint32_t)(nowUs - h.lastUs) * 1e-6f;
		h.rad += (dps - h.biasDps) * (float)M_PI / 180.0f * dt;
	}
	h.started = true;
	h.lastUs = nowUs;
}
