// Factory-test firmware (env esp32c3_test), generated per design: include/testkit.h names the self-tests the contract's
// parts call for and pins.h where they are wired. The board sits on the bed-of-nails fixture; the station powers it
// through its USB-C port (or a battery simulator on the VBAT pad for the current steps, see test-plan.md), measures the
// rails on the test pads, and reads these lines on USB serial:
//
//   BRINGUP-TEST <id> PASS|FAIL <detail>
//   BRINGUP-TEST done <passed>/<total>
//
// Then the board deep-sleeps, so the station can measure the sleep current (test plan step "sleep").
#ifdef FACTORY_TEST
#include <Arduino.h>
#include <Wire.h>
#include "pins.h"
#include "testkit.h"
#include "identity.h"
#include <bootloader_random.h>
#ifdef TEST_MIC
#include <ESP_I2S.h>
#endif

static int passed = 0;
static int total = 0;

static void report(const char *id, bool ok, const char *detail) {
	total++;
	if (ok) passed++;
	Serial.printf("BRINGUP-TEST %s %s %s\n", id, ok ? "PASS" : "FAIL", detail);
}

#if TEST_OUTPUT_COUNT > 0
// Drive each output high and low and read the pin back: a pin shorted hard to a rail or a neighbour reads the other
// level. This reads the MCU's own pin, so an open trace still passes; the fixture's reading on the test pad is what
// proves the trace from the MCU to the part.
static void testOutputs() {
	const int pins[] = TEST_OUTPUTS;
	const char *names[] = TEST_OUTPUT_NAMES;
	for (int i = 0; i < TEST_OUTPUT_COUNT; i++) {
		pinMode(pins[i], OUTPUT);
		digitalWrite(pins[i], HIGH);
		delay(200);
		const int high = digitalRead(pins[i]);
		digitalWrite(pins[i], LOW);
		delay(200);
		const int low = digitalRead(pins[i]);
		char detail[48];
		snprintf(detail, sizeof detail, "GPIO%d high=%d low=%d", pins[i], high, low);
		char id[40];
		snprintf(id, sizeof id, "out-%s", names[i]);
		report(id, high == HIGH && low == LOW, detail);
	}
}
#endif

#if TEST_INPUT_COUNT > 0
// A button idles high on its pull-up; low means the line is shorted to ground (or the button is held).
static void testInputs() {
	const int pins[] = TEST_INPUTS;
	const char *names[] = TEST_INPUT_NAMES;
	for (int i = 0; i < TEST_INPUT_COUNT; i++) {
		pinMode(pins[i], INPUT_PULLUP);
		delay(10);
		char id[40];
		snprintf(id, sizeof id, "in-%s", names[i]);
		char detail[32];
		snprintf(detail, sizeof detail, "GPIO%d idle=%d", pins[i], digitalRead(pins[i]));
		report(id, digitalRead(pins[i]) == HIGH, detail);
	}
}
#endif

#ifdef TEST_I2C_SENSOR
// The sensor answers its address: proves SDA, SCL, their pull-ups and the sensor's supply in one step. Addresses as
// main.cpp: SHTC3 0x70 (datasheet v4 Table 8), SHT40 0x44.
#if defined(SENSOR_SHTC3)
static const uint8_t SENSOR_ADDR = 0x70;
#else
static const uint8_t SENSOR_ADDR = 0x44;
#endif
static void testSensor() {
	Wire.begin(TEST_I2C_SDA, TEST_I2C_SCL);
	Wire.beginTransmission(SENSOR_ADDR);
	const uint8_t err = Wire.endTransmission();
	char detail[40];
	snprintf(detail, sizeof detail, "addr 0x%02x err=%u", SENSOR_ADDR, err);
	report("i2c-sensor", err == 0, detail);
	Wire.end();
}
#endif

#ifdef TEST_MIC
// The microphone's data line carries samples while it is clocked: a stuck line (open, or shorted to a rail) reads one
// constant value. Room noise alone moves an ICS-43434's output by more than a few counts at 16 bits.
static void testMic() {
	I2SClass i2s;
	i2s.setPins(TEST_MIC_SCK, TEST_MIC_WS, -1, TEST_MIC_SD);
	if (!i2s.begin(I2S_MODE_STD, 16000, I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO, I2S_STD_SLOT_LEFT)) {
		report("mic", false, "i2s begin failed");
		return;
	}
	static int32_t raw[1600];
	// The first 100 ms are the microphone's start-up: read and dropped.
	i2s.readBytes((char *)raw, sizeof raw);
	const size_t got = i2s.readBytes((char *)raw, sizeof raw) / sizeof raw[0];
	int lo = INT16_MAX, hi = INT16_MIN;
	for (size_t i = 0; i < got; i++) {
		const int v = raw[i] >> 16;
		lo = min(lo, v);
		hi = max(hi, v);
	}
	i2s.end();
	char detail[48];
	snprintf(detail, sizeof detail, "samples=%u peak-to-peak=%d", (unsigned)got, got ? hi - lo : 0);
	report("mic", got > 0 && hi - lo >= 4, detail);
}
#endif

void setup() {
	Serial.begin(115200);
	// The station opens the port after power-up; give it a moment, without waiting forever on a board with no host.
	for (int i = 0; i < 30 && !Serial; i++) delay(100);
	Serial.printf("BRINGUP-TEST start rev=%d\n", TEST_REVISION);
	// The device's identity, made here on the line: its own Bluetooth passkey (identity.h), with the hardware random
	// source on (the radio is off in this firmware). The station prints it on the device's label with the FCC ID.
	bootloader_random_enable();
	bool madePasskey = false;
	const uint32_t passkey = devicePasskey(&madePasskey);
	bootloader_random_disable();
	Serial.printf("BRINGUP-TEST identity mac=%012llx passkey=%06lu %s\n", (unsigned long long)ESP.getEfuseMac(), (unsigned long)passkey, madePasskey ? "new" : "kept");
#if TEST_OUTPUT_COUNT > 0
	testOutputs();
#endif
#if TEST_INPUT_COUNT > 0
	testInputs();
#endif
#ifdef TEST_I2C_SENSOR
	testSensor();
#endif
#ifdef TEST_MIC
	testMic();
#endif
	Serial.printf("BRINGUP-TEST done %d/%d\n", passed, total);
	Serial.flush();
	delay(500);
	// Sleep current: the station measures it now. Timer wake-up after a minute starts the test over.
	esp_sleep_enable_timer_wakeup(60ULL * 1000 * 1000);
	esp_deep_sleep_start();
}

void loop() {}
#endif
