// Framing for messages between boards (docs/system.md), on open standards (16 Nov 2026; before, our own sync bytes and
// XOR): the frame is the message definition's hash (4 bytes, little endian), the payload length, the payload and a
// CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, big endian) over all of them, COBS-encoded (Cheshire and Baker,
// "Consistent Overhead Byte Stuffing", IEEE/ACM ToN 1999) and ended by a 0x00. A 0x00 never occurs inside a frame, so a
// receiver resynchronises at the next one, and a lone 0x00 (an I2C target with nothing to send) is an empty frame it
// skips; a 0x00 is also sent before each frame, so garbage on the line never swallows the next one. A receiver drops a frame whose hash isn't one it knows, so two boards built against different definitions
// never misread each other.
#pragma once
#include <Arduino.h>

static const uint8_t LINK_MAX_PAYLOAD = 48;
// hash 4 + length 1 + payload + CRC 2; on the wire, COBS's one overhead byte and a 0x00 before and after.
static const uint8_t LINK_RAW_MAX = 4 + 1 + LINK_MAX_PAYLOAD + 2;
static const uint8_t LINK_FRAME_MAX = LINK_RAW_MAX + 1 + 2;

static inline uint16_t linkCrc16(const uint8_t *p, uint8_t n) {
	uint16_t crc = 0xFFFF;
	for (uint8_t i = 0; i < n; i++) {
		crc ^= (uint16_t)p[i] << 8;
		for (uint8_t b = 0; b < 8; b++) crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
	}
	return crc;
}

static inline void linkFrameWrite(Print &out, uint32_t hash, const void *data, uint8_t len) {
	if (len > LINK_MAX_PAYLOAD) return;
	uint8_t raw[LINK_RAW_MAX];
	uint8_t n = 0;
	raw[n++] = (uint8_t)hash;
	raw[n++] = (uint8_t)(hash >> 8);
	raw[n++] = (uint8_t)(hash >> 16);
	raw[n++] = (uint8_t)(hash >> 24);
	raw[n++] = len;
	for (uint8_t i = 0; i < len; i++) raw[n++] = ((const uint8_t *)data)[i];
	const uint16_t crc = linkCrc16(raw, n);
	raw[n++] = (uint8_t)(crc >> 8);
	raw[n++] = (uint8_t)crc;
	// COBS: each block is a code byte (its length + 1) and the non-zero bytes up to the next zero. A frame is at most 55
	// bytes, so no block reaches COBS's 254-byte limit.
	// A 0x00 before the frame too: garbage or a damaged frame on the line ends there, not inside this frame.
	uint8_t enc[LINK_FRAME_MAX];
	enc[0] = 0x00;
	uint8_t w = 2, code = 1, codeAt = 1;
	for (uint8_t i = 0; i < n; i++) {
		if (raw[i] == 0) {
			enc[codeAt] = code;
			codeAt = w++;
			code = 1;
		} else {
			enc[w++] = raw[i];
			code++;
		}
	}
	enc[codeAt] = code;
	enc[w++] = 0x00;
	out.write(enc, w);
}

// Fed one byte at a time; true when a whole, checked frame has arrived (hash, payload and len then hold it).
struct LinkFrameReader {
	uint8_t buf[LINK_FRAME_MAX];
	uint8_t raw[LINK_RAW_MAX];
	uint8_t n = 0; // bytes since the last 0x00; sizeof buf marks a frame too long to be ours
	bool feed(uint8_t b, uint32_t &hash, const uint8_t *&payload, uint8_t &len) {
		if (b != 0x00) {
			if (n < sizeof buf) buf[n++] = b;
			return false;
		}
		const uint8_t got = n;
		n = 0;
		if (got == 0 || got >= sizeof buf) return false; // an empty frame, or one longer than any we send
		uint8_t r = 0;
		for (uint8_t i = 0; i < got;) {
			const uint8_t code = buf[i++];
			if (code == 0 || i + code - 1 > got) return false;
			for (uint8_t k = 1; k < code; k++) {
				if (r >= sizeof raw) return false;
				raw[r++] = buf[i++];
			}
			if (code < 0xFF && i < got) {
				if (r >= sizeof raw) return false;
				raw[r++] = 0;
			}
		}
		if (r < 7) return false;
		const uint8_t l = raw[4];
		if (l > LINK_MAX_PAYLOAD || r != 7u + l) return false;
		const uint16_t crc = (uint16_t)raw[5 + l] << 8 | raw[6 + l];
		if (linkCrc16(raw, 5 + l) != crc) return false;
		hash = raw[0] | (uint32_t)raw[1] << 8 | (uint32_t)raw[2] << 16 | (uint32_t)raw[3] << 24;
		payload = raw + 5;
		len = l;
		return true;
	}
};
