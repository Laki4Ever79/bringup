// The board build: DRV8833 inputs on LEDC PWM (one channel per input, slow-decay off: the driven input PWMs, the other
// is low), the VL53L0X breakout and the SHT40 or SHTC3 on I2C.
#ifndef HW_SIM
#include <Arduino.h>
#include <Wire.h>
#include <VL53L0X.h>
#include <NimBLEDevice.h>
#include "bthome.h"
#include "hw.h"
#include "hw_pins.h"
// The drivers, shared with the product firmware and run on the host after every build (src/tools/driver-tests.ts).
#include "drivers/drv8833.h"
#include "drivers/vl53l0x.h"
#include "drivers/sensirion.h"

static VL53L0X tof;
static bool tofOk = false;
static const int PWM_HZ = 20000, PWM_BITS = 10;
static const int IN[2][2] = {{MOT_AIN1, MOT_AIN2}, {MOT_BIN1, MOT_BIN2}};

#if defined(PIN_ENC_LA) && defined(PIN_ENC_RA)
// The wheel encoders (an encoder gearmotor's Hall encoder): every edge of channel A steps the wheel's count, forward or
// back as the duty last driven (channel B isn't wired: the ESP32-C3 has the pins for one channel per wheel). The
// ESP32-C3 has no pulse-counter unit, so GPIO interrupts count them (about 2000 edges a second per wheel at cruise).
static volatile int32_t encCount[2] = {0, 0};
static volatile int8_t encDir[2] = {1, 1};
static void IRAM_ATTR encLeft(void) { encCount[0] += encDir[0]; }
static void IRAM_ATTR encRight(void) { encCount[1] += encDir[1]; }
int32_t hw_encoder(int side) { return encCount[side & 1]; }
#define ENC_DIR(side, duty) (encDir[side] = (duty) < 0 ? -1 : 1)
#else
int32_t hw_encoder(int) { return 0; }
#define ENC_DIR(side, duty)
#endif

void hw_begin(void) {
#if defined(PIN_ENC_LA) && defined(PIN_ENC_RA)
	pinMode(PIN_ENC_LA, INPUT);  // the encoder pulls its outputs up itself (10 kOhm to its Vcc)
	pinMode(PIN_ENC_RA, INPUT);
	attachInterrupt(digitalPinToInterrupt(PIN_ENC_LA), encLeft, CHANGE);
	attachInterrupt(digitalPinToInterrupt(PIN_ENC_RA), encRight, CHANGE);
#endif
	for (auto &m : IN) for (int pin : m) { ledcAttach(pin, PWM_HZ, PWM_BITS); ledcWrite(pin, 0); }
	Wire.begin(I2C_SDA, I2C_SCL);
	tof.setTimeout(100);
	tofOk = tof.init();
	if (tofOk) { tof.setMeasurementTimingBudget(ROVER_PERIOD_MS * 1000); tof.startContinuous(); }
}

void hw_motor(int side, float duty) {
	ENC_DIR(side & 1, duty);
	const Drv8833Levels l = drv8833Levels(duty, (1 << PWM_BITS) - 1);
	ledcWrite(IN[side][0], l.in1);
	ledcWrite(IN[side][1], l.in2);
}

int hw_distance_mm(void) {
	if (!tofOk) { delay(ROVER_PERIOD_MS); return -1; }
	int mm = tof.readRangeContinuousMillimeters();  // blocks until the next reading: the control tick
	return tofDistanceMm(mm, tof.timeoutOccurred(), ROVER_RANGE_MM);
}

// The payload: the contract's temperature/humidity sensor, SHT40 or SHTC3, with the product firmware's drivers
// (include/drivers/sensirion.h: CRC-checked, humidity cropped to 0..100). hw_pins.h defines which; none reads nothing.
bool hw_payload(float *temp_c, float *rh) {
#if defined(SENSOR_SHTC3)
	return shtc3Read(temp_c, rh);
#elif defined(SENSOR_SHT40)
	return sht4xRead(temp_c, rh);
#else
	return false;
#endif
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
