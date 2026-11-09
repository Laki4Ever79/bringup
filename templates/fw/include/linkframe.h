// Framing for messages between boards (docs/system.md): sync A5 5A, the message definition's hash (4 bytes, little
// endian), the payload length, the payload, and an XOR checksum. A receiver drops a frame whose hash isn't one it
// knows, so two boards built against different definitions never misread each other.
#pragma once
#include <Arduino.h>

static const uint8_t LINK_SYNC0 = 0xA5, LINK_SYNC1 = 0x5A, LINK_MAX_PAYLOAD = 48;

static inline void linkFrameWrite(Print &out, uint32_t hash, const void *data, uint8_t len) {
	uint8_t head[7] = {LINK_SYNC0, LINK_SYNC1, (uint8_t)hash, (uint8_t)(hash >> 8), (uint8_t)(hash >> 16), (uint8_t)(hash >> 24), len};
	uint8_t sum = 0;
	for (uint8_t i = 2; i < 7; i++) sum ^= head[i];
	for (uint8_t i = 0; i < len; i++) sum ^= ((const uint8_t *)data)[i];
	out.write(head, sizeof head);
	out.write((const uint8_t *)data, len);
	out.write(sum);
}

// Fed one byte at a time; true when a whole, checked frame has arrived (hash, payload and len then hold it).
struct LinkFrameReader {
	uint8_t buf[7 + LINK_MAX_PAYLOAD + 1];
	uint8_t n = 0;
	bool feed(uint8_t b, uint32_t &hash, const uint8_t *&payload, uint8_t &len) {
		if ((n == 0 && b != LINK_SYNC0) || (n == 1 && b != LINK_SYNC1)) {
			n = (b == LINK_SYNC0) ? 1 : 0;
			if (n) buf[0] = b;
			return false;
		}
		buf[n++] = b;
		if (n == 7 && buf[6] > LINK_MAX_PAYLOAD) n = 0;
		if (n < 7 || n < 8u + buf[6]) return false;
		uint8_t sum = 0;
		for (uint8_t i = 2; i < 7u + buf[6]; i++) sum ^= buf[i];
		const bool good = sum == buf[7 + buf[6]];
		n = 0;
		if (!good) return false;
		hash = buf[2] | (uint32_t)buf[3] << 8 | (uint32_t)buf[4] << 16 | (uint32_t)buf[5] << 24;
		payload = buf + 7;
		len = buf[6];
		return true;
	}
};
