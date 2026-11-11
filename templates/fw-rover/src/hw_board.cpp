// The board build: DRV8833 inputs on LEDC PWM (one channel per input, slow-decay off: the driven input PWMs, the other
// is low), the VL53L0X breakout and the SHT40 on I2C.
#ifndef HW_SIM
#include <Arduino.h>
#include <Wire.h>
#include <VL53L0X.h>
#include <NimBLEDevice.h>
#include "bthome.h"
#include "hw.h"
#include "hw_pins.h"

static VL53L0X tof;
static bool tofOk = false;
static const int PWM_HZ = 20000, PWM_BITS = 10;
static const int IN[2][2] = {{MOT_AIN1, MOT_AIN2}, {MOT_BIN1, MOT_BIN2}};

void hw_begin(void) {
	for (auto &m : IN) for (int pin : m) { ledcAttach(pin, PWM_HZ, PWM_BITS); ledcWrite(pin, 0); }
	Wire.begin(I2C_SDA, I2C_SCL);
	tof.setTimeout(100);
	tofOk = tof.init();
	if (tofOk) { tof.setMeasurementTimingBudget(ROVER_PERIOD_MS * 1000); tof.startContinuous(); }
}

void hw_motor(int side, float duty) {
	if (duty > 1) duty = 1;
	if (duty < -1) duty = -1;
	int level = (int)(fabsf(duty) * ((1 << PWM_BITS) - 1));
	ledcWrite(IN[side][0], duty >= 0 ? level : 0);
	ledcWrite(IN[side][1], duty >= 0 ? 0 : level);
}

int hw_distance_mm(void) {
	if (!tofOk) { delay(ROVER_PERIOD_MS); return -1; }
	int mm = tof.readRangeContinuousMillimeters();  // blocks until the next reading: the control tick
	return (tof.timeoutOccurred() || mm >= ROVER_RANGE_MM) ? -1 : mm;
}

// SHT40: measure at high precision (0xFD), 6 bytes back (Sensirion SHT4x datasheet §4.5).
bool hw_payload(float *temp_c, float *rh) {
#ifndef SENSOR_SHT40
	return false;  // only the SHT40 is read here; the header defines SENSOR_SHT40 when the contract's sensor is one
#endif
	Wire.beginTransmission(0x44);
	Wire.write(0xFD);
	if (Wire.endTransmission() != 0) return false;
	delay(10);
	if (Wire.requestFrom(0x44, 6) != 6) return false;
	uint8_t b[6];
	for (auto &x : b) x = Wire.read();
	*temp_c = -45 + 175 * ((b[0] << 8) | b[1]) / 65535.0f;
	*rh = -6 + 125 * ((b[3] << 8) | b[4]) / 65535.0f;
	return true;
}

uint32_t hw_now_ms(void) { return millis(); }

// The payload over BLE: a non-connectable BTHome v2 broadcast (bthome.io; Home Assistant decodes it with no app), the
// latest reading in the advertisement, refreshed on each reading. Advertising runs on the radio's own schedule, so the
// control loop isn't held. A failed reading broadcasts the packet id alone.
static bool bleUp = false;
static uint8_t packetId = 0;
static char bleName[16];

void hw_report(bool ok, float temp_c, float rh) {
	if (!bleUp) {
		snprintf(bleName, sizeof bleName, "Rover-%04X", (unsigned)(ESP.getEfuseMac() >> 32) & 0xFFFF);
		NimBLEDevice::init(bleName);
		NimBLEDevice::getAdvertising()->setConnectableMode(BLE_GAP_CONN_MODE_NON);
		bleUp = true;
	}
	NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
	uint8_t data[12];
	const size_t n = bthomeServiceData(data, packetId++, ok, temp_c, rh);
	NimBLEAdvertisementData ad;
	ad.setFlags(BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP);
	ad.setServiceData(NimBLEUUID(BTHOME_UUID), data, n);
	ad.setName(bleName);
	adv->stop();
	adv->setAdvertisementData(ad);
	adv->start();
}
#endif
