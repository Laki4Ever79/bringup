// BTHome v2 service data (bthome.io/format), the bytes that follow the 16-bit service UUID 0xFCD2 in a BLE
// advertisement. Home Assistant's built-in BTHome integration decodes them with no app. Plain C++ with no Arduino
// dependency, so test/bthome.test.ts compiles this same file on the host and checks it against the spec's examples.
//
// Layout: the device information byte (0x40: no encryption, sent at a regular interval, version 2), then objects in
// ascending object id, as the spec requires (a receiver stops at the first id it doesn't know):
//   0x00 packet id     uint8               Home Assistant drops a packet whose id it has just seen
//   0x02 temperature   sint16 LE, 0.01 °C
//   0x03 humidity      uint16 LE, 0.01 %
#pragma once
#include <stddef.h>
#include <stdint.h>
#include <math.h>

static const uint16_t BTHOME_UUID = 0xFCD2;
static const uint8_t BTHOME_INFO_V2 = 0x40;

// packetId < 0 leaves the packet id out; hasClimate false leaves the readings out (a failed or absent sensor).
// Returns the bytes written to out (at most 9).
static inline size_t bthomeServiceData(uint8_t *out, int packetId, bool hasClimate, float tempC, float rh) {
	size_t n = 0;
	out[n++] = BTHOME_INFO_V2;
	if (packetId >= 0) {
		out[n++] = 0x00;
		out[n++] = (uint8_t)(packetId & 0xFF);
	}
	if (hasClimate) {
		long t = lroundf(tempC * 100.0f);
		if (t < -32768) t = -32768;
		if (t > 32767) t = 32767;
		long h = lroundf(rh * 100.0f);
		if (h < 0) h = 0;
		if (h > 10000) h = 10000;
		const uint16_t tu = (uint16_t)(int16_t)t;
		out[n++] = 0x02;
		out[n++] = (uint8_t)(tu & 0xFF);
		out[n++] = (uint8_t)(tu >> 8);
		out[n++] = 0x03;
		out[n++] = (uint8_t)(h & 0xFF);
		out[n++] = (uint8_t)((h >> 8) & 0xFF);
	}
	return n;
}
