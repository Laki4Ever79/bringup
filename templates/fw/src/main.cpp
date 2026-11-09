// Bringup firmware template. include/pins.h is generated from the design contract.
#include <Arduino.h>
#include <Wire.h>
#include "pins.h"
// The radio and how readings leave the device (contract field connectivity, codegen/firmware.ts connectivityHeader).
// Without it: Bluetooth LE with the GATT service, as the template always had.
#if __has_include("connectivity.h")
#include "connectivity.h"
#endif
#if !defined(RADIO_BLE) && !defined(RADIO_WIFI)
#define RADIO_BLE 1
#define REPORT_GATT 1
#endif
#if __has_include("model.h")
#include "model.h"
#endif

#if defined(MODEL_PRESENT) && MODEL_PRESENT
// The on-device model's memory, sized from the contract (model.h): the tensor arena in RAM and the weights in flash, so
// the build's own RAM and flash figures include the model and one that doesn't fit fails the link. The weights are a
// placeholder until a converted model (model_data.cc) replaces them; the first byte is non-zero so the array stays
// in flash (.rodata) rather than being treated as zero-filled data.
alignas(16) static uint8_t modelArena[MODEL_ARENA_BYTES];
#if __has_include("model_data.h")
// The converted model itself (py/quantize.py's model_data.cc, linked by the build): flash holds the real model.
#include "model_data.h"
#define modelWeights g_model
#define MODEL_WEIGHTS_LINKED_BYTES g_model_len
#else
static const uint8_t modelWeights[MODEL_WEIGHTS_BYTES] = {1};
#define MODEL_WEIGHTS_LINKED_BYTES sizeof modelWeights
#endif
#endif

#if defined(PIN_I2C_SDA) && defined(PIN_I2C_SCL)
static_assert(PIN_I2C_SDA >= 0 && PIN_I2C_SDA < SOC_GPIO_PIN_COUNT, "PIN_I2C_SDA is not a GPIO on this chip");
static_assert(PIN_I2C_SCL >= 0 && PIN_I2C_SCL < SOC_GPIO_PIN_COUNT, "PIN_I2C_SCL is not a GPIO on this chip");
#define HAS_I2C 1
// The sensor is the only I2C part the product firmware drives: a design with no I2C pins has no sensor (briefs/beacon.md).
#define HAS_SENSOR 1
#endif

#ifdef PIN_STATUS_LED
static_assert(PIN_STATUS_LED >= 0 && PIN_STATUS_LED < SOC_GPIO_PIN_COUNT, "PIN_STATUS_LED is not a GPIO on this chip");
#define HAS_LED 1
#endif

// The temperature/humidity sensor the contract's parts call for: pins.h defines SENSOR_SHTC3 or SENSOR_SHT40.
// Without either (pins.h from before the sensor was recorded) it is the SHT40.
#if defined(SENSOR_SHTC3)
// SHTC3 datasheet v4 (Dec 2022): I2C address 0x70 (Table 8), wakeup 0x3517 (Table 10, up to 240 us), sleep 0xB098
// (Table 9, 0.3 uA typ.), measure T first in normal mode without clock stretching 0x7866 (up to 12.1 ms).
static const uint8_t SENSOR_ADDR = 0x70;
#define SENSOR_NAME "shtc3"

static bool shtc3Command(uint16_t cmd) {
	Wire.beginTransmission(SENSOR_ADDR);
	Wire.write(cmd >> 8);
	Wire.write(cmd & 0xFF);
	return Wire.endTransmission() == 0;
}
#else
static const uint8_t SENSOR_ADDR = 0x44;
static const uint8_t SHT40_MEASURE_HIGH = 0xFD;
#define SENSOR_NAME "sht40"
#endif

// Sensirion CRC-8: polynomial 0x31, init 0xFF.
static uint8_t crc8(const uint8_t *data, int len) {
	uint8_t crc = 0xFF;
	for (int i = 0; i < len; i++) {
		crc ^= data[i];
		for (int b = 0; b < 8; b++) crc = (crc & 0x80) ? (crc << 1) ^ 0x31 : crc << 1;
	}
	return crc;
}

static bool readClimate(float *tempC, float *rh) {
#ifdef HAS_I2C
#if defined(SENSOR_SHTC3)
	if (!shtc3Command(0x3517)) return false;
	delayMicroseconds(240);
	if (!shtc3Command(0x7866)) return false;
	delay(13);
#else
	Wire.beginTransmission(SENSOR_ADDR);
	Wire.write(SHT40_MEASURE_HIGH);
	if (Wire.endTransmission() != 0) return false;
	delay(10);
#endif
	uint8_t buf[6];
	if (Wire.requestFrom(SENSOR_ADDR, (uint8_t)6) != 6) return false;
	for (int i = 0; i < 6; i++) buf[i] = Wire.read();
#if defined(SENSOR_SHTC3)
	shtc3Command(0xB098);
#endif
	if (crc8(buf, 2) != buf[2] || crc8(buf + 3, 2) != buf[5]) return false;
	const uint16_t rawT = buf[0] << 8 | buf[1], rawRh = buf[3] << 8 | buf[4];
#if defined(SENSOR_SHTC3)
	*tempC = -45 + 175 * (rawT / 65536.0f);
	*rh = 100 * (rawRh / 65536.0f);
#else
	*tempC = -45 + 175 * (rawT / 65535.0f);
	*rh = -6 + 125 * (rawRh / 65535.0f);
#endif
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
// The product: one reading per wake. Read the sensor, store the reading, blink briefly, advertise, deep-sleep for the
// contract's period (pins.h DUTY_PERIOD_S, from requirements.dutyCycle.periodS); a board with no sensor only blinks and
// advertises. Each wake starts again at setup().
#include <esp_sleep.h>
#include <LittleFS.h>
#include <Preferences.h>

#ifndef DUTY_PERIOD_S
#define DUTY_PERIOD_S 300  // the brief's "a reading every few minutes"
#endif
static const uint32_t READING_BLINK_MS = 20;
// The history: a ring buffer of HISTORY_DAYS of readings in /history.bin on the flash's LittleFS partition, one
// 4-byte record per reading; the next slot to write is kept in NVS, so it survives deep sleep and power loss.
#ifndef HISTORY_DAYS
#define HISTORY_DAYS 30  // pins.h sets it from requirements.historyDays
#endif
static const uint32_t HISTORY_SLOTS = HISTORY_DAYS * 86400UL / DUTY_PERIOD_S;
static const char *HISTORY_FILE = "/history.bin";

#ifdef HAS_SENSOR
// The record layout is the generated data format's (include/dataformat.h, record.h): the reader decodes the same.
#include "record.h"

// Returns the slot written, or -1 if the flash couldn't take it. NVS also keeps how many slots hold a reading, for BLE.
static int32_t storeReading(float tempC, float rh) {
	if (!LittleFS.begin(true)) return -1;  // formats the partition on the very first boot
	Preferences prefs;
	prefs.begin("history", false);
	uint32_t slot = prefs.getUInt("next", 0) % HISTORY_SLOTS;
	File f = LittleFS.open(HISTORY_FILE, LittleFS.exists(HISTORY_FILE) ? "r+" : "w+");
	bool ok = f && f.seek(slot * sizeof(uint32_t));
	uint32_t record = packReading(tempC, rh);
	ok = ok && f.write((const uint8_t *)&record, sizeof record) == sizeof record;
	if (f) f.close();
	if (ok) {
		prefs.putUInt("next", (slot + 1) % HISTORY_SLOTS);
		prefs.putUInt("count", min(prefs.getUInt("count", 0) + 1, HISTORY_SLOTS));
	}
	prefs.end();
	LittleFS.end();
	return ok ? (int32_t)slot : -1;
}
#endif

// BLE (NimBLE-Arduino, pinned in platformio.ini): after each reading the device advertises for BLE_ADVERTISE_MS
// (pins.h, generated from the contract's dutyCycle.activeMs minus the reading), so it is awake as long as the battery
// math assumes. A phone that connects keeps it awake until it disconnects or BLE_CONNECTED_MAX_MS pass. The service:
// - latest (read): this wake's reading as one packed record, 0xFFFFFFFF if the sensor failed, 0xFFFFFFFE on a board
//   with no sensor (count stays 0 and the history empty);
// - count (read): how many readings the history holds;
// - offset (read/write): how many of the newest records the next history read skips;
// - history (read): up to HISTORY_CHUNK records, newest first, from offset on. Records are packReading()'s, little-endian.
#ifdef RADIO_BLE
#include <NimBLEDevice.h>
#include "identity.h"
#ifdef REPORT_BTHOME
#include "bthome.h"
// The packet id Home Assistant uses to drop repeats: one per reading, kept across deep sleep.
RTC_DATA_ATTR static uint8_t bthomePacketId = 0;
#endif

#ifndef BLE_ADVERTISE_MS
#define BLE_ADVERTISE_MS 300  // the logger brief's 300 ms advertising burst, without a contract duty cycle
#endif
static const uint32_t BLE_CONNECTED_MAX_MS = 30000;
// UUIDs and limits from the generated data format (include/dataformat.h), the source the reader is made from too.
#include "dataformat.h"
static const uint32_t HISTORY_CHUNK = DF_HISTORY_CHUNK;
static const uint32_t LATEST_SENSOR_FAILED = DF_LATEST_SENSOR_FAILED, LATEST_NO_SENSOR = DF_LATEST_NO_SENSOR;
static const char *BLE_SERVICE_UUID = DF_GATT_SERVICE;
static const char *BLE_LATEST_UUID = DF_GATT_LATEST;
static const char *BLE_COUNT_UUID = DF_GATT_COUNT;
static const char *BLE_OFFSET_UUID = DF_GATT_OFFSET;
static const char *BLE_HISTORY_UUID = DF_GATT_HISTORY;

static volatile bool bleConnected = false;
static uint32_t historyNext = 0, historyCount = 0, historyOffset = 0;

class ServerCallbacks : public NimBLEServerCallbacks {
	void onConnect(NimBLEServer *, NimBLEConnInfo &) override { bleConnected = true; }
	void onDisconnect(NimBLEServer *, NimBLEConnInfo &, int) override { bleConnected = false; }
};

class OffsetCallbacks : public NimBLECharacteristicCallbacks {
	void onWrite(NimBLECharacteristic *c, NimBLEConnInfo &) override { historyOffset = c->getValue<uint32_t>(); }
};

// Reads the newest records first, straight from /history.bin: slot next-1 is the newest.
class HistoryCallbacks : public NimBLECharacteristicCallbacks {
	void onRead(NimBLECharacteristic *c, NimBLEConnInfo &) override {
		static uint32_t records[HISTORY_CHUNK];
		uint32_t n = 0;
		File f = LittleFS.open(HISTORY_FILE, "r");
		for (uint32_t i = historyOffset; f && i < historyCount && n < HISTORY_CHUNK; i++) {
			uint32_t slot = (historyNext + HISTORY_SLOTS - 1 - i) % HISTORY_SLOTS;
			if (!f.seek(slot * sizeof(uint32_t)) || f.read((uint8_t *)&records[n], sizeof(uint32_t)) != sizeof(uint32_t)) break;
			n++;
		}
		if (f) f.close();
		c->setValue((const uint8_t *)records, n * sizeof(uint32_t));
	}
};

// latest: the packed reading for the GATT service; ok, tempC and rh: the same reading for BTHome.
static void serveBle(uint32_t latest, bool ok, float tempC, float rh) {
	Preferences prefs;
	prefs.begin("history", true);
	historyNext = prefs.getUInt("next", 0);
	historyCount = prefs.getUInt("count", 0);
	prefs.end();
	LittleFS.begin(false);
	char name[16];
	snprintf(name, sizeof name, "Bringup-%04X", (unsigned)(ESP.getEfuseMac() >> 32) & 0xFFFF);
	NimBLEDevice::init(name);
	NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
#ifdef REPORT_BTHOME
	// The reading as BTHome v2 service data, with the flags BlueZ needs and the name: 3 + 13 + 14 bytes, inside the
	// 31 a legacy advertisement holds. The GATT service's 128-bit UUID moves to the scan response.
	uint8_t bthome[12];
	const size_t bthomeLen = bthomeServiceData(bthome, bthomePacketId++, ok, tempC, rh);
	NimBLEAdvertisementData advData;
	advData.setFlags(BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP);
	advData.setServiceData(NimBLEUUID(BTHOME_UUID), bthome, bthomeLen);
	advData.setName(name);
	adv->setAdvertisementData(advData);
#ifdef REPORT_GATT
	NimBLEAdvertisementData scanData;
	scanData.addServiceUUID(BLE_SERVICE_UUID);
	adv->setScanResponseData(scanData);
	adv->enableScanResponse(true);
#else
	// BTHome only: a broadcast nobody connects to.
	adv->setConnectableMode(BLE_GAP_CONN_MODE_NON);
#endif
#else
	(void)ok;
	(void)tempC;
	(void)rh;
#endif
#ifdef REPORT_GATT
	// The history is readable only over an authenticated, encrypted link: LE Secure Connections with this device's own
	// passkey (identity.h), which the phone's owner types in once; the bond is kept.
	bool madePasskey = false;
	const uint32_t passkey = devicePasskey(&madePasskey);
	if (madePasskey) Serial.printf("BLE passkey %06lu (new: label the device with it)\n", (unsigned long)passkey);
	NimBLEDevice::setSecurityAuth(true, true, true);
	NimBLEDevice::setSecurityIOCap(BLE_HS_IO_DISPLAY_ONLY);
	NimBLEDevice::setSecurityPasskey(passkey);
	NimBLEServer *server = NimBLEDevice::createServer();
	server->setCallbacks(new ServerCallbacks());
	NimBLEService *service = server->createService(BLE_SERVICE_UUID);
	const uint32_t SECURE_READ = NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::READ_ENC | NIMBLE_PROPERTY::READ_AUTHEN;
	const uint32_t SECURE_WRITE = NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_ENC | NIMBLE_PROPERTY::WRITE_AUTHEN;
	service->createCharacteristic(BLE_LATEST_UUID, SECURE_READ)->setValue(latest);
	service->createCharacteristic(BLE_COUNT_UUID, SECURE_READ)->setValue(historyCount);
	NimBLECharacteristic *offset = service->createCharacteristic(BLE_OFFSET_UUID, SECURE_READ | SECURE_WRITE);
	offset->setValue(historyOffset = 0);  // reads 0 until a phone writes one (it read empty on the S3)
	offset->setCallbacks(new OffsetCallbacks());
	service->createCharacteristic(BLE_HISTORY_UUID, SECURE_READ)->setCallbacks(new HistoryCallbacks());
	service->start();
#ifndef REPORT_BTHOME
	adv->setName(name);
	adv->addServiceUUID(BLE_SERVICE_UUID);
#endif
#else
	(void)latest;
#endif
	adv->start();
	Serial.printf("BLE %s advertising %d ms\n", name, BLE_ADVERTISE_MS);
	const uint32_t start = millis();
	bool everConnected = false;
	for (;;) {
		const uint32_t awake = millis() - start;
		everConnected |= bleConnected;
		if (bleConnected ? awake >= BLE_CONNECTED_MAX_MS : awake >= BLE_ADVERTISE_MS) break;
		delay(5);
	}
	if (everConnected) Serial.println("BLE a phone connected");
	NimBLEDevice::deinit(true);
	LittleFS.end();
}

#endif  // RADIO_BLE

#ifdef RADIO_WIFI
// Wi-Fi: every wake reads and stores; every UPLOAD_EVERY wakes the device connects once and uploads, because joining
// a network costs seconds of radio time. Credentials come from include/secrets.h, which the engineer provides and
// nothing generates or commits (WIFI_SSID, WIFI_PASS, MQTT_HOST, MQTT_PORT, optional MQTT_USER, MQTT_PASS, OTA_URL).
// Without it the firmware still builds, and says it isn't provisioned.
#include <WiFi.h>
#include <WiFiClientSecure.h>
#if __has_include("secrets.h")
#include "secrets.h"
#endif
#ifndef UPLOAD_EVERY
#define UPLOAD_EVERY 12
#endif
static const uint32_t WIFI_CONNECT_TIMEOUT_MS = 10000;
// Wakes since the last upload, kept across deep sleep; the first wake after power-up uploads straight away.
RTC_DATA_ATTR static uint32_t wakesSinceUpload = UPLOAD_EVERY;

#ifdef REPORT_MQTT
#include <PubSubClient.h>
#include "dataformat.h"
// Home Assistant's MQTT discovery: one retained config message per sensor tells Home Assistant what the state topic
// holds; then each upload publishes the newest reading as the state, and the readings since the last upload as a batch
// (packed records, oldest first, PERIOD_S apart) that the generated reader decodes.
static void publishMqtt(PubSubClient &mqtt, const char *id, bool ok, float tempC, float rh) {
	char topic[96], body[512], state[48];
	snprintf(state, sizeof state, DF_MQTT_PREFIX "/%s/state", id);
	const char *names[] = {"temperature", "humidity"};
	const char *units[] = {"\xC2\xB0" "C", "%"};
	for (int i = 0; i < 2; i++) {
		snprintf(topic, sizeof topic, DF_MQTT_DISCOVERY "/sensor/%s_%s/config", id, names[i]);
		snprintf(body, sizeof body,
			"{\"name\":\"%s\",\"unique_id\":\"%s_%s\",\"state_topic\":\"%s\",\"device_class\":\"%s\",\"unit_of_measurement\":\"%s\","
			"\"value_template\":\"{{ value_json.%s }}\",\"expire_after\":%lu,"
			"\"device\":{\"identifiers\":[\"%s\"],\"name\":\"Bringup %s\",\"manufacturer\":\"Bringup\",\"sw_version\":\"rev %d\"}}",
			names[i], id, names[i], state, names[i], units[i], names[i], (unsigned long)UPLOAD_EVERY * DUTY_PERIOD_S * 2 + 60, id, id, BRINGUP_REVISION);
		mqtt.publish(topic, body, true);
	}
	if (ok) {
		snprintf(body, sizeof body, "{\"temperature\":%.2f,\"humidity\":%.2f}", tempC, rh);
		mqtt.publish(state, body, true);
	}
#ifdef HAS_SENSOR
	// The batch: the newest UPLOAD_EVERY records, oldest first, straight from /history.bin.
	Preferences prefs;
	prefs.begin("history", true);
	const uint32_t next = prefs.getUInt("next", 0), count = prefs.getUInt("count", 0);
	prefs.end();
	const uint32_t n = min((uint32_t)UPLOAD_EVERY, count);
	int len = snprintf(body, sizeof body, "{\"periodS\":%d,\"records\":[", DUTY_PERIOD_S);
	if (LittleFS.begin(false)) {
		File f = LittleFS.open(HISTORY_FILE, "r");
		for (uint32_t i = 0; f && i < n && len < (int)sizeof body - 16; i++) {
			uint32_t slot = (next + HISTORY_SLOTS - n + i) % HISTORY_SLOTS, record = 0;
			if (!f.seek(slot * sizeof record) || f.read((uint8_t *)&record, sizeof record) != sizeof record) break;
			len += snprintf(body + len, sizeof body - len, "%s%lu", i ? "," : "", (unsigned long)record);
		}
		if (f) f.close();
		LittleFS.end();
	}
	snprintf(body + len, sizeof body - len, "]}");
	snprintf(topic, sizeof topic, DF_MQTT_PREFIX "/%s/history", id);
	mqtt.publish(topic, body, false);
#endif
}
#endif

#ifdef UPDATES_OTA
#include <HTTPUpdate.h>
#endif

static void serveWifi(bool ok, float tempC, float rh) {
	if (++wakesSinceUpload < UPLOAD_EVERY) {
		Serial.printf("WIFI upload in %lu wakes\n", (unsigned long)(UPLOAD_EVERY - wakesSinceUpload));
		return;
	}
	wakesSinceUpload = 0;
#if !defined(WIFI_SSID) || !defined(WIFI_PASS)
	(void)ok;
	(void)tempC;
	(void)rh;
	Serial.println("WIFI not provisioned: include/secrets.h has no WIFI_SSID/WIFI_PASS");
#else
	WiFi.mode(WIFI_STA);
	WiFi.begin(WIFI_SSID, WIFI_PASS);
	const uint32_t start = millis();
	while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_CONNECT_TIMEOUT_MS) delay(20);
	if (WiFi.status() != WL_CONNECTED) {
		Serial.printf("WIFI no connection after %lu ms\n", (unsigned long)(millis() - start));
		WiFi.mode(WIFI_OFF);
		return;
	}
	Serial.printf("WIFI connected in %lu ms\n", (unsigned long)(millis() - start));
	char id[20];
	snprintf(id, sizeof id, "bringup_%06llx", (unsigned long long)(ESP.getEfuseMac() & 0xFFFFFF));
#if defined(REPORT_MQTT) && defined(MQTT_HOST)
	// Secure by default: TLS against the broker's CA (MQTT_CA); plain MQTT only when the engineer sets
	// MQTT_ALLOW_PLAINTEXT (a broker on a closed home network), and never by accident.
#if defined(MQTT_CA)
	WiFiClientSecure net;
	net.setCACert(MQTT_CA);
#elif defined(MQTT_ALLOW_PLAINTEXT)
	WiFiClient net;
#endif
#if defined(MQTT_CA) || defined(MQTT_ALLOW_PLAINTEXT)
	PubSubClient mqtt(net);
	mqtt.setServer(MQTT_HOST, MQTT_PORT);
	mqtt.setBufferSize(640);
#if defined(MQTT_USER) && defined(MQTT_PASS)
	const bool joined = mqtt.connect(id, MQTT_USER, MQTT_PASS);
#else
	const bool joined = mqtt.connect(id);
#endif
	if (joined) {
		publishMqtt(mqtt, id, ok, tempC, rh);
		mqtt.loop();
		mqtt.disconnect();
		Serial.println("MQTT published");
	} else Serial.printf("MQTT connect failed (%d)\n", mqtt.state());
#else
	(void)ok;
	(void)tempC;
	(void)rh;
	Serial.println("MQTT refused: no MQTT_CA for TLS, and MQTT_ALLOW_PLAINTEXT not set");
#endif
#else
	(void)ok;
	(void)tempC;
	(void)rh;
#endif
#if defined(UPDATES_OTA) && defined(OTA_URL)
	// The update server answers with a newer image or 304; the current revision goes along as x-ESP32-version. Over
	// HTTPS against OTA_CA by default; plain HTTP only with OTA_ALLOW_PLAINTEXT.
#if defined(OTA_CA)
	WiFiClientSecure ota;
	ota.setCACert(OTA_CA);
#elif defined(OTA_ALLOW_PLAINTEXT)
	WiFiClient ota;
#endif
#if defined(OTA_CA) || defined(OTA_ALLOW_PLAINTEXT)
	httpUpdate.rebootOnUpdate(true);
	const t_httpUpdate_return r = httpUpdate.update(ota, OTA_URL, String(BRINGUP_REVISION));
	Serial.printf("OTA %s\n", r == HTTP_UPDATE_NO_UPDATES ? "up to date" : r == HTTP_UPDATE_OK ? "updated" : httpUpdate.getLastErrorString().c_str());
#else
	Serial.println("OTA refused: no OTA_CA for HTTPS, and OTA_ALLOW_PLAINTEXT not set");
#endif
#endif
	WiFi.disconnect(true);
	WiFi.mode(WIFI_OFF);
#endif
}
#endif  // RADIO_WIFI

// A brief blink when the reading worked, a double blink when the sensor didn't answer.
static void readingBlink(bool sensorOk) {
	for (int i = 0; i < (sensorOk ? 1 : 2); i++) {
		led(true);
		delay(READING_BLINK_MS);
		led(false);
		if (!sensorOk) delay(150);
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
// Shaking: any reading whose magnitude is off 1 g by this much (or jumps this much between samples) counts, and the
// state lasts SHAKE_HOLD_MS after the last one, so a shake reads as one clear red burst on stage.
static const float SHAKE_G = 0.35f;
static const uint32_t SHAKE_HOLD_MS = 1500;
static const uint32_t SHAKE_BLINK_MS = 120;
static uint32_t shakeUntil = 0;

static bool shaking() {
	return shakeUntil != 0 && (int32_t)(shakeUntil - millis()) > 0;
}

// Green normally, red while shaking.
static void benchLed(bool on) {
	led(on);
	bool red = shaking();
	rgbLedWrite(BENCH_RGB_PIN, on && red ? 60 : 0, on && !red ? 40 : 0, 0);
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

// One "s" line. Tilt is measured from the pose the board had when the firmware started (its first good reading), not
// from vertical, so it works however the MPU-6050 happens to sit on the breadboard. Temperature comes from the design's sensor
// when the board has one, else the MPU's die.
static float sampleLine(bool ledOn) {
	float a[3] = {0, 0, 0}, mpuT = 0, t = 0, rh = 0;
	bool imu = readMpu(a, &mpuT);
	bool sht = readClimate(&t, &rh);
	static float rest[3] = {0, 0, 0};
	static bool haveRest = false;
	static float lastMag = 1.0f;
	float tilt = 0;
	float mag = sqrtf(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
	if (imu && mag > 0.2f) {
		if (!haveRest) {
			for (int i = 0; i < 3; i++) rest[i] = a[i] / mag;
			haveRest = true;
		}
		float c = (a[0] * rest[0] + a[1] * rest[1] + a[2] * rest[2]) / mag;
		tilt = acosf(fmaxf(-1.0f, fminf(1.0f, c))) * 180.0f / (float)M_PI;
		if (fabsf(mag - 1.0f) > SHAKE_G || fabsf(mag - lastMag) > SHAKE_G) shakeUntil = millis() + SHAKE_HOLD_MS;
		lastMag = mag;
	}
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
	tele("{\"k\":\"s\",\"rev\":%d,\"ms\":%lu,\"ax\":%.3f,\"ay\":%.3f,\"az\":%.3f,\"tilt\":%.1f,\"shake\":%d,\"tC\":%s,\"tSrc\":\"%s\",\"led\":%d}\n",
		BRINGUP_REVISION, (unsigned long)millis(), a[0], a[1], a[2], tilt, shaking() ? 1 : 0, temp, sht ? SENSOR_NAME : imu ? "mpu" : "none", ledOn ? 1 : 0);
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

// Live: a sample every 50 ms, and the LED toggling every half period: green, faster while tilted past
// BEHAVIOR_TILT_DEG, and fast red while shaking.
void loop() {
	static uint32_t nextSample = 0, nextToggle = 0;
	static bool ledOn = false;
	static float tilt = 0;
	// A flash or reset drops the USB link, and the laptop reopens the port a moment after boot, too late for the
	// first boot line. Repeat it once a second for 5 s, so a bench reading over the S3's own USB sees which revision
	// is running. (The S3 counts as connected as soon as it is plugged in, so "the port was opened" can't be seen.)
	static uint32_t nextBootLine = 1000;
	if (millis() < 6000 && (int32_t)(millis() - nextBootLine) >= 0) {
		nextBootLine += 1000;
		bootLine(false);
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
		uint32_t period = shaking() ? SHAKE_BLINK_MS : tilt > BEHAVIOR_TILT_DEG ? BEHAVIOR_TILT_BLINK_MS : BEHAVIOR_BLINK_MS;
		nextToggle = now + period / 2;
	}
	if ((int32_t)(now - nextSample) >= 0) {
		nextSample = now + LIVE_SAMPLE_MS;
		tilt = sampleLine(ledOn);
	}
	delay(1);
}
#else
// One reading: read, store, blink, then advertise or upload.
static void takeReading() {
#ifdef HAS_SENSOR
	float t, rh;
	bool ok = readClimate(&t, &rh);
	if (ok) Serial.printf("SENSOR OK %.2f C %.1f %%RH\n", t, rh);
	else Serial.println("SENSOR FAIL");
	if (ok) Serial.printf("HISTORY slot %ld\n", (long)storeReading(t, rh));
	readingBlink(ok);
#ifdef RADIO_BLE
	serveBle(ok ? packReading(t, rh) : LATEST_SENSOR_FAILED, ok, t, rh);
#else
	serveWifi(ok, t, rh);
#endif
#else
	// No sensor: nothing to read or store. Blink once and advertise (or upload).
	Serial.println("SENSOR NONE");
	readingBlink(true);
#ifdef RADIO_BLE
	serveBle(LATEST_NO_SENSOR, false, 0, 0);
#else
	serveWifi(false, 0, 0);
#endif
#endif
}

#ifdef PIN_USB_SENSE
// USB wake (codegen/circuit.ts usbWake): a 68k/100k divider puts VBUS on PIN_USB_SENSE. While USB is plugged in the
// board stays awake, so its USB Serial/JTAG stays up and `pio run -t upload` reflashes it with the cable alone; it keeps
// taking a reading every period meanwhile (USB powers it, the battery charges). Unplugged, it goes back to deep sleep
// within 100 ms, and plugging in wakes it (only GPIO0..5 can wake the ESP32-C3 from deep sleep).
static_assert(PIN_USB_SENSE >= 0 && PIN_USB_SENSE <= 5, "PIN_USB_SENSE cannot wake the ESP32-C3 from deep sleep (GPIO0..5 only)");
static bool usbPowered() {
	return digitalRead(PIN_USB_SENSE) == HIGH;
}

static void stayAwakeOnUsb() {
	pinMode(PIN_USB_SENSE, INPUT);  // the divider's 100k holds it low unplugged: no internal pull
	if (!usbPowered()) return;
	Serial.println("USB powered: staying awake");
	uint32_t last = millis();
	while (usbPowered()) {
		if (millis() - last >= (uint32_t)DUTY_PERIOD_S * 1000UL) {
			last = millis();
			takeReading();
		}
		delay(100);
	}
	Serial.println("USB unplugged");
}
#endif

void setup() {
	Serial.begin(115200);
	Serial.printf("bringup rev %d\n", BRINGUP_REVISION);
#if defined(MODEL_PRESENT) && MODEL_PRESENT
	// Taking the addresses keeps both arrays in the image (the linker drops unreferenced sections).
	Serial.printf("MODEL arena %u B at %p, weights %u B at %p, %d Hz x %d ms\n", (unsigned)sizeof modelArena, (void *)modelArena, (unsigned)MODEL_WEIGHTS_LINKED_BYTES, (const void *)modelWeights, MODEL_SAMPLE_RATE_HZ, MODEL_WINDOW_MS);
#endif
#ifdef HAS_I2C
	Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
#endif
#ifdef HAS_LED
	pinMode(PIN_STATUS_LED, OUTPUT);
#endif
	takeReading();
#ifdef PIN_USB_SENSE
	stayAwakeOnUsb();
#endif
	Serial.printf("SLEEP %d s\n", DUTY_PERIOD_S);
	Serial.flush();
	esp_sleep_enable_timer_wakeup((uint64_t)DUTY_PERIOD_S * 1000000ULL);
#ifdef PIN_BUTTON
	// The button closes to GND (codegen wires its other side there): a press wakes the board early. Only GPIO0..5 can
	// wake the ESP32-C3 from deep sleep (TRM, "Deep-sleep wakeup"); the internal pull-up holds the pin high meanwhile.
	static_assert(PIN_BUTTON >= 0 && PIN_BUTTON <= 5, "PIN_BUTTON cannot wake the ESP32-C3 from deep sleep (GPIO0..5 only)");
	gpio_pullup_en((gpio_num_t)PIN_BUTTON);
	gpio_pulldown_dis((gpio_num_t)PIN_BUTTON);
	esp_deep_sleep_enable_gpio_wakeup(1ULL << PIN_BUTTON, ESP_GPIO_WAKEUP_GPIO_LOW);
#endif
#ifdef PIN_USB_SENSE
	// Plugging in USB wakes it (high on the sense pin); the wake pins accumulate, so a button's low wake still works.
	gpio_pullup_dis((gpio_num_t)PIN_USB_SENSE);
	gpio_pulldown_dis((gpio_num_t)PIN_USB_SENSE);
	esp_deep_sleep_enable_gpio_wakeup(1ULL << PIN_USB_SENSE, ESP_GPIO_WAKEUP_GPIO_HIGH);
#endif
	esp_deep_sleep_start();
}

// Never reached: setup() ends in deep sleep, and a timer, button or USB wake starts at setup() again.
void loop() {}
#endif
