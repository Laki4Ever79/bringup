// Data-collection firmware (env esp32c3_collect), generated per design like the product firmware: it reads the
// model's sensor on the contract's pins at the model's rate and gain, one model window at a time, and streams each
// window over USB serial, stamped with the contract revision and the sensor path's hash (model.h MODEL_PATH_HASH).
// py/collect.py records the stream into a dataset that belongs to that one sensor path, so training data always
// matches the hardware it will run on. Microphones only, so far.
//
// The stream: a text line
//   BRINGUP-COLLECT rev=<n> path=<hash> sensor=microphone rate=<Hz> channels=<n> bits=16 samples=<per window>
// at boot and every HEADER_EVERY windows, and between those, one binary frame per window:
//   "BRW1", uint32 seq, uint32 samples (little-endian), then samples × int16 (little-endian).
#ifdef COLLECT
#include <Arduino.h>
#include <ESP_I2S.h>
#include "pins.h"
#include "model.h"

#if !(defined(MODEL_PRESENT) && MODEL_PRESENT)
#error "data collection needs a model in the contract (model.h has MODEL_PRESENT 0)"
#endif
#ifndef MODEL_SENSOR_MICROPHONE
#error "data collection is generated for microphones only so far"
#endif
#if !defined(PIN_MIC_SCK) || !defined(PIN_MIC_WS) || !defined(PIN_MIC_SD)
#error "the microphone's I2S SCK, WS and SD must be assigned in the contract's pins"
#endif
#if MODEL_CHANNELS != 1
#error "the I2S microphone is read as one channel (LR selects it)"
#endif

static const uint32_t HEADER_EVERY = 10;
// The ESP32-C3's USB Serial/JTAG ignores the rate; a board behind a UART bridge needs it: 16 kHz × 16 bit is 32 KB/s.
static const uint32_t SERIAL_BAUD = 921600;

static I2SClass i2s;
static int16_t window[MODEL_WINDOW_SAMPLES];
static uint32_t seq = 0;

static void header() {
	Serial.printf("BRINGUP-COLLECT rev=%d path=%s sensor=microphone rate=%d channels=%d bits=%d samples=%d\n", BRINGUP_REVISION, MODEL_PATH_HASH, MODEL_SAMPLE_RATE_HZ, MODEL_CHANNELS, MIC_SAMPLE_BITS, MODEL_WINDOW_SAMPLES);
}

static void writeU32(uint32_t v) {
	const uint8_t b[4] = {(uint8_t)v, (uint8_t)(v >> 8), (uint8_t)(v >> 16), (uint8_t)(v >> 24)};
	Serial.write(b, 4);
}

void setup() {
	Serial.begin(SERIAL_BAUD);
	// The ICS-43434 is an I2S receive-only part: no data out from the MCU, no master clock.
	i2s.setPins(PIN_MIC_SCK, PIN_MIC_WS, -1, PIN_MIC_SD);
	static_assert(MIC_SLOT_BITS == 32, "the ICS-43434 sends 24-bit samples in a 32-bit slot");
	if (!i2s.begin(I2S_MODE_STD, MODEL_SAMPLE_RATE_HZ, I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO, MIC_CHANNEL_LEFT ? I2S_STD_SLOT_LEFT : I2S_STD_SLOT_RIGHT)) {
		for (;;) {
			Serial.println("BRINGUP-COLLECT FAIL i2s begin");
			delay(1000);
		}
	}
	header();
}

void loop() {
	// One window of samples: the top MIC_SAMPLE_BITS of each MSB-aligned 24-bit sample (a fixed gain, part of the path).
	size_t n = 0;
	while (n < MODEL_WINDOW_SAMPLES) {
		int32_t raw[64];
		const size_t got = i2s.readBytes((char *)raw, sizeof raw) / sizeof raw[0];
		for (size_t i = 0; i < got && n < MODEL_WINDOW_SAMPLES; i++) window[n++] = (int16_t)(raw[i] >> MIC_SHIFT);
	}
	Serial.write((const uint8_t *)"BRW1", 4);
	writeU32(seq);
	writeU32(n);
	Serial.write((const uint8_t *)window, n * sizeof window[0]);
	if (++seq % HEADER_EVERY == 0) header();
}
#endif
