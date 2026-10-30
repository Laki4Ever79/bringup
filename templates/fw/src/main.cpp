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

#ifndef BENCH
// One 2 s reading period: a steady 1 Hz blink while the sensor answers, a double blink when it doesn't.
static void blinkPeriod(bool sensorOk) {
	if (sensorOk) {
		for (int i = 0; i < 2; i++) { led(true); delay(500); led(false); delay(500); }
	} else {
		for (int i = 0; i < 2; i++) { led(true); delay(100); led(false); delay(150); }
		delay(1500);
	}
}
#endif

#ifdef BENCH
// The bench build (docs/design/bench.md §2): the same pins and sensor code, plus an MPU-6050 for tilt, JSON-lines
// telemetry on UART1 and two modes chosen by the fixture on BENCH_MODE: live (awake, 20 Hz) or duty cycle (wake,
// sample, blink, sleep BENCH_PERIOD_S). The fixture's INA226 measures the current; this firmware only reports.
#include <esp_sleep.h>
#include <math.h>

#if __has_include("behavior.h")
#include "behavior.h"
#endif
#ifndef BEHAVIOR_BLINK_MS
#define BEHAVIOR_BLINK_MS 1000
#endif
#ifndef BEHAVIOR_TILT_BLINK_MS
#define BEHAVIOR_TILT_BLINK_MS BEHAVIOR_BLINK_MS
#endif
#ifndef BEHAVIOR_TILT_DEG
#define BEHAVIOR_TILT_DEG 90
#endif

// Bench-only pins, outside the contract. py/bench.py refuses to flash a contract that uses them.
static const int BENCH_MODE_PIN = 4;  // fixture GP12 through 1 kΩ: HIGH = duty cycle
static const int BENCH_TX_PIN = 17;   // UART1 TX → CP2102 RXD
static const uint32_t LIVE_SAMPLE_MS = 50;
static const uint32_t DUTY_BLINK_MS = 20;
static const uint8_t MPU_ADDR = 0x68;
static const int BENCH_RGB_PIN = 48;  // the YD-ESP32-S3's onboard RGB LED: the status light when none is wired

RTC_DATA_ATTR static uint32_t dutyCycles = 0;

// The contract's STATUS_LED (if a LED is wired) and the onboard RGB LED, together.
static void benchLed(bool on) {
	led(on);
	rgbLedWrite(BENCH_RGB_PIN, 0, on ? 40 : 0, 0);
}

// Every telemetry line goes out twice: on UART1 (GPIO17, for a CP2102 if one is wired) and on the S3's own USB, which
// is how a bench with no CP2102 reads it. USB writes never block: with no host listening they are dropped.
static void tele(const char *fmt, ...) {
	char line[256];
	va_list args;
	va_start(args, fmt);
	vsnprintf(line, sizeof line, fmt, args);
	va_end(args);
	Serial1.print(line);
	Serial.print(line);
}

static void teleFlush() {
	Serial1.flush();
	Serial.flush();
}

static bool mpuWrite(uint8_t reg, uint8_t value) {
	Wire.beginTransmission(MPU_ADDR);
	Wire.write(reg);
	Wire.write(value);
	return Wire.endTransmission() == 0;
}

// Accelerometer in g (±2 g range) and the die temperature.
static bool readMpu(float accel[3], float *tempC) {
	Wire.beginTransmission(MPU_ADDR);
	Wire.write(0x3B);  // ACCEL_XOUT_H: accel x/y/z, temperature, gyro x/y/z
	if (Wire.endTransmission(false) != 0) return false;
	if (Wire.requestFrom(MPU_ADDR, (uint8_t)8) != 8) return false;
	int16_t raw[4];
	for (int i = 0; i < 4; i++) {
		uint8_t hi = Wire.read();
		uint8_t lo = Wire.read();
		raw[i] = (int16_t)(hi << 8 | lo);
	}
	for (int i = 0; i < 3; i++) accel[i] = raw[i] / 16384.0f;
	*tempC = raw[3] / 340.0f + 36.53f;
	return true;
}

static const char *resetName() {
	switch (esp_reset_reason()) {
		case ESP_RST_POWERON: return "poweron";  // also an EN pulse from the fixture
		case ESP_RST_DEEPSLEEP: return "deepsleep";
		case ESP_RST_USB: return "usb";  // esptool's reset after a flash
		case ESP_RST_SW: return "sw";
		case ESP_RST_PANIC: return "panic";
		case ESP_RST_INT_WDT:
		case ESP_RST_TASK_WDT:
		case ESP_RST_WDT: return "wdt";
		case ESP_RST_BROWNOUT: return "brownout";
		default: return "other";
	}
}

// One "s" line: tilt from vertical, and the temperature from the SHT40 when the board has one, else the MPU's die.
static float sampleLine(bool ledOn) {
	float a[3] = {0, 0, 0}, mpuT = 0, t = 0, rh = 0;
	bool imu = readMpu(a, &mpuT);
	bool sht = readSht40(&t, &rh);
	float tilt = atan2f(sqrtf(a[0] * a[0] + a[1] * a[1]), a[2]) * 180.0f / (float)M_PI;
	if (!imu) {
		static uint32_t lastErr = 0;
		if (lastErr == 0 || millis() - lastErr >= 1000) {
			lastErr = millis();
			tele("{\"k\":\"err\",\"rev\":%d,\"what\":\"imu\",\"detail\":\"no ACK at 0x68\"}\n", BRINGUP_REVISION);
		}
	}
	// No temperature sensor at all (a bare S3) reports null, not a made-up 0 °C.
	char temp[16];
	if (sht || imu) snprintf(temp, sizeof temp, "%.2f", sht ? t : mpuT);
	else snprintf(temp, sizeof temp, "null");
	tele("{\"k\":\"s\",\"rev\":%d,\"ms\":%lu,\"ax\":%.3f,\"ay\":%.3f,\"az\":%.3f,\"tilt\":%.1f,\"tC\":%s,\"tSrc\":\"%s\",\"led\":%d}\n",
		BRINGUP_REVISION, (unsigned long)millis(), a[0], a[1], a[2], imu ? tilt : 0.0f, temp, sht ? "sht40" : imu ? "mpu" : "none", ledOn ? 1 : 0);
	return imu ? tilt : 0.0f;
}

static void bootLine(bool duty) {
	tele("{\"k\":\"boot\",\"rev\":%d,\"reset\":\"%s\",\"mode\":\"%s\"}\n", BRINGUP_REVISION, resetName(), duty ? "duty" : "live");
}

// Wake, sample, blink once, report how long the whole wake took, sleep. Never returns.
static void dutyCycle() {
	dutyCycles++;
	mpuWrite(0x6B, 0x00);  // PWR_MGMT_1: wake the MPU-6050
	delay(10);
	benchLed(true);
	sampleLine(true);
	delay(DUTY_BLINK_MS);
	benchLed(false);
	tele("{\"k\":\"cycle\",\"rev\":%d,\"n\":%lu,\"awakeMs\":%lu}\n", BRINGUP_REVISION, (unsigned long)dutyCycles, (unsigned long)millis());
	teleFlush();
	mpuWrite(0x6B, 0x40);  // MPU-6050 to sleep, or its ~4 mA would swamp the floor
	esp_sleep_enable_timer_wakeup((uint64_t)BENCH_PERIOD_S * 1000000ULL);
	esp_deep_sleep_start();
}

void setup() {
	Serial1.begin(115200, SERIAL_8N1, -1, BENCH_TX_PIN);
	Serial.begin(115200);
	Serial.setTxTimeoutMs(0);
	pinMode(BENCH_MODE_PIN, INPUT_PULLDOWN);
	bool duty = digitalRead(BENCH_MODE_PIN) == HIGH;
	if (esp_reset_reason() != ESP_RST_DEEPSLEEP) dutyCycles = 0;
#ifdef HAS_I2C
	Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
#endif
#ifdef HAS_LED
	pinMode(PIN_STATUS_LED, OUTPUT);
#endif
	bootLine(duty);
	if (duty) dutyCycle();
	mpuWrite(0x6B, 0x00);
}

// Live: a sample every 50 ms, and the LED toggling every half period, faster while tilted past BEHAVIOR_TILT_DEG.
void loop() {
	static uint32_t nextSample = 0, nextToggle = 0;
	static bool ledOn = false;
	static float tilt = 0;
	// A flash or reset drops the USB link, and the laptop reopens it a moment after boot: say boot again when it
	// does, so a bench reading over the S3's own USB still sees which revision is running.
	static bool usbHost = false;
	if ((bool)Serial != usbHost) {
		usbHost = (bool)Serial;
		if (usbHost) bootLine(false);
	}
	if (digitalRead(BENCH_MODE_PIN) == HIGH) {
		benchLed(false);
		teleFlush();
		esp_restart();  // boots straight into duty-cycle mode
	}
	uint32_t now = millis();
	if ((int32_t)(now - nextToggle) >= 0) {
		ledOn = !ledOn;
		benchLed(ledOn);
		nextToggle = now + (tilt > BEHAVIOR_TILT_DEG ? BEHAVIOR_TILT_BLINK_MS : BEHAVIOR_BLINK_MS) / 2;
	}
	if ((int32_t)(now - nextSample) >= 0) {
		nextSample = now + LIVE_SAMPLE_MS;
		tilt = sampleLine(ledOn);
	}
	delay(1);
}
#else
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
#endif
