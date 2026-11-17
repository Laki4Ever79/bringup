// The payload of a message between boards over UART or I2C, as CBOR (RFC 8949, an open standard; 16 Nov 2026, before:
// the message's packed C struct): a map from each field's name to its value, so any CBOR tool reads a frame without our
// headers. Integers in their shortest form (major types 0 and 1), floats as single precision (0xFA). A reader takes
// any number form another encoder may use (half, single or double floats, integers up to 8 bytes) and finds fields by
// name, so their order doesn't matter. The frame around it (hash, length, CRC, COBS) is linkframe.h's.
#pragma once
#include <Arduino.h>

struct LinkCborWriter {
	uint8_t *p;
	uint8_t cap;
	uint8_t n = 0;
	bool ok = true; // false once something didn't fit
	LinkCborWriter(uint8_t *buf, uint8_t size) : p(buf), cap(size) {}
	void put(uint8_t b) {
		if (n < cap) p[n++] = b;
		else ok = false;
	}
	void head(uint8_t major, uint32_t v) {
		const uint8_t m = (uint8_t)(major << 5);
		if (v < 24) put((uint8_t)(m | v));
		else if (v <= 0xFF) put(m | 24), put((uint8_t)v);
		else if (v <= 0xFFFF) put(m | 25), put((uint8_t)(v >> 8)), put((uint8_t)v);
		else put(m | 26), put((uint8_t)(v >> 24)), put((uint8_t)(v >> 16)), put((uint8_t)(v >> 8)), put((uint8_t)v);
	}
	void map(uint8_t pairs) { head(5, pairs); }
	void key(const char *k) {
		const size_t l = strlen(k);
		head(3, (uint32_t)l);
		for (size_t i = 0; i < l; i++) put((uint8_t)k[i]);
	}
	void u(uint32_t v) { head(0, v); }
	void i(int32_t v) {
		if (v >= 0) head(0, (uint32_t)v);
		else head(1, (uint32_t)(-(v + 1)));
	}
	void f(float v) {
		uint32_t b;
		memcpy(&b, &v, 4);
		put(0xFA), put((uint8_t)(b >> 24)), put((uint8_t)(b >> 16)), put((uint8_t)(b >> 8)), put((uint8_t)b);
	}
};

// One item's head at p[at]: its major type and argument (additional info 0-27); false past the end or on an
// indefinite length, which a link payload never has.
static inline bool linkCborHead(const uint8_t *p, uint8_t len, uint8_t &at, uint8_t &major, uint8_t &info, uint64_t &arg) {
	if (at >= len) return false;
	const uint8_t b = p[at++];
	major = b >> 5;
	info = b & 0x1F;
	if (info < 24) {
		arg = info;
		return true;
	}
	if (info > 27) return false;
	const uint8_t bytes = (uint8_t)(1u << (info - 24));
	if ((unsigned)at + bytes > len) return false;
	arg = 0;
	for (uint8_t k = 0; k < bytes; k++) arg = arg << 8 | p[at++];
	return true;
}

static inline float linkCborHalf(uint16_t h) {
	const uint32_t sign = (uint32_t)(h & 0x8000) << 16;
	int32_t exp = (h >> 10) & 0x1F;
	uint32_t mant = h & 0x3FF;
	uint32_t bits;
	if (exp == 0x1F) bits = sign | 0x7F800000u | (mant << 13);
	else if (exp == 0) {
		if (mant == 0) bits = sign;
		else {
			exp = 1;
			while (!(mant & 0x400)) mant <<= 1, exp--;
			mant &= 0x3FF;
			bits = sign | (uint32_t)(exp + 127 - 15) << 23 | mant << 13;
		}
	} else bits = sign | (uint32_t)(exp + 127 - 15) << 23 | mant << 13;
	float f;
	memcpy(&f, &bits, 4);
	return f;
}

// The number under `key` in a payload that is one CBOR map: true and `out` set when the key is there with a number.
// A payload that isn't a map of text keys to numbers finds nothing.
static inline bool linkCborNumber(const uint8_t *p, uint8_t len, const char *key, double &out) {
	uint8_t at = 0, major, info;
	uint64_t pairs, arg;
	if (!linkCborHead(p, len, at, major, info, pairs) || major != 5) return false;
	const size_t klen = strlen(key);
	for (uint64_t i = 0; i < pairs; i++) {
		if (!linkCborHead(p, len, at, major, info, arg) || major != 3 || (unsigned)at + arg > len) return false;
		const bool match = arg == klen && memcmp(p + at, key, klen) == 0;
		at = (uint8_t)(at + arg);
		if (!linkCborHead(p, len, at, major, info, arg)) return false;
		double v;
		if (major == 0) v = (double)arg;
		else if (major == 1) v = -1.0 - (double)arg;
		else if (major == 7 && info == 25) v = linkCborHalf((uint16_t)arg);
		else if (major == 7 && info == 26) {
			const uint32_t b = (uint32_t)arg;
			float f;
			memcpy(&f, &b, 4);
			v = f;
		} else if (major == 7 && info == 27) memcpy(&v, &arg, 8);
		else return false; // not a number: this payload isn't one of ours
		if (match) {
			out = v;
			return true;
		}
	}
	return false;
}
