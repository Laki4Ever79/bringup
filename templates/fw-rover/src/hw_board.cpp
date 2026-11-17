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

#if defined(ROVER_TURN_COUNTS) && defined(ROVER_ENC_QUADRATURE) && defined(PIN_ENC_LA) && defined(PIN_ENC_RA) && defined(PIN_ENC_LB) && defined(PIN_ENC_RB)
// Both channels of each wheel's encoder (an MCU with the pins, the ESP32-S3): the direction is the encoder's. The
// ESP32-S3 decodes them in hardware: one PCNT unit per wheel, two channels counting every edge of A and of B, each
// with the other channel's level as its direction (x4, Espressif's rotary-encoder example), the 16-bit counter
// accumulated into 32 bits at its limits. A chip with no pulse counters steps rover_quad.h's table on every edge.
// The sign against the duty is learned once from the first drive (rover_quad.h quad_forward).
#include "rover_quad.h"
static QuadSign encSign[2];
static volatile float encDuty[2] = {0, 0};
#define ENC_DIR(side, duty) (encDuty[side] = (duty))
#include "soc/soc_caps.h"
#if SOC_PCNT_SUPPORTED
#include "driver/pulse_cnt.h"
static pcnt_unit_handle_t encUnit[2] = {nullptr, nullptr};
static void encBegin(int side, int a, int b) {
	pcnt_unit_config_t u = {};
	u.low_limit = -30000;
	u.high_limit = 30000;
	u.flags.accum_count = 1;
	pcnt_new_unit(&u, &encUnit[side]);
	pcnt_glitch_filter_config_t f = {.max_glitch_ns = 1000};
	pcnt_unit_set_glitch_filter(encUnit[side], &f);
	pcnt_chan_config_t ca = {};
	ca.edge_gpio_num = a;
	ca.level_gpio_num = b;
	pcnt_channel_handle_t cha, chb;
	pcnt_new_channel(encUnit[side], &ca, &cha);
	pcnt_chan_config_t cb = {};
	cb.edge_gpio_num = b;
	cb.level_gpio_num = a;
	pcnt_new_channel(encUnit[side], &cb, &chb);
	pcnt_channel_set_edge_action(cha, PCNT_CHANNEL_EDGE_ACTION_DECREASE, PCNT_CHANNEL_EDGE_ACTION_INCREASE);
	pcnt_channel_set_level_action(cha, PCNT_CHANNEL_LEVEL_ACTION_KEEP, PCNT_CHANNEL_LEVEL_ACTION_INVERSE);
	pcnt_channel_set_edge_action(chb, PCNT_CHANNEL_EDGE_ACTION_INCREASE, PCNT_CHANNEL_EDGE_ACTION_DECREASE);
	pcnt_channel_set_level_action(chb, PCNT_CHANNEL_LEVEL_ACTION_KEEP, PCNT_CHANNEL_LEVEL_ACTION_INVERSE);
	pcnt_unit_add_watch_point(encUnit[side], u.high_limit);
	pcnt_unit_add_watch_point(encUnit[side], u.low_limit);
	pcnt_unit_enable(encUnit[side]);
	pcnt_unit_clear_count(encUnit[side]);
	pcnt_unit_start(encUnit[side]);
}
static int32_t encRaw(int side) {
	int v = 0;
	if (encUnit[side]) pcnt_unit_get_count(encUnit[side], &v);
	return v;
}
#else
static volatile int32_t encCount[2] = {0, 0};
static volatile uint8_t encAB[2] = {0, 0};
static const int ENC_PINS[2][2] = {{PIN_ENC_LA, PIN_ENC_LB}, {PIN_ENC_RA, PIN_ENC_RB}};
static void IRAM_ATTR encEdge(int side) {
	const uint8_t ab = (uint8_t)((digitalRead(ENC_PINS[side][0]) << 1) | digitalRead(ENC_PINS[side][1]));
	encCount[side] += quad_delta(encAB[side], ab);
	encAB[side] = ab;
}
static void IRAM_ATTR encLeft(void) { encEdge(0); }
static void IRAM_ATTR encRight(void) { encEdge(1); }
static void encBegin(int side, int a, int b) {
	encAB[side] = (uint8_t)((digitalRead(a) << 1) | digitalRead(b));
	attachInterrupt(digitalPinToInterrupt(a), side ? encRight : encLeft, CHANGE);
	attachInterrupt(digitalPinToInterrupt(b), side ? encRight : encLeft, CHANGE);
}
static int32_t encRaw(int side) { return encCount[side]; }
#endif
int32_t hw_encoder(int side) { return quad_forward(encSign[side & 1], encRaw(side & 1), encDuty[side & 1]); }
#elif defined(ROVER_TURN_COUNTS) && defined(PIN_ENC_LA) && defined(PIN_ENC_RA)
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
#define ENC_DIR(side, duty)
#endif

void hw_begin(void) {
#if defined(ROVER_TURN_COUNTS) && defined(ROVER_ENC_QUADRATURE) && defined(PIN_ENC_LA) && defined(PIN_ENC_RA) && defined(PIN_ENC_LB) && defined(PIN_ENC_RB)
	for (int pin : {PIN_ENC_LA, PIN_ENC_LB, PIN_ENC_RA, PIN_ENC_RB}) pinMode(pin, INPUT);  // the encoder pulls its outputs up
	encBegin(0, PIN_ENC_LA, PIN_ENC_LB);
	encBegin(1, PIN_ENC_RA, PIN_ENC_RB);
#elif defined(ROVER_TURN_COUNTS) && defined(PIN_ENC_LA) && defined(PIN_ENC_RA)
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
