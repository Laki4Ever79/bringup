// Runs linkcbor.h on the host against RFC 8949's Appendix A examples: one line per case, PASS <name> or FAIL <name>;
// exit code = failures.
#include <math.h>
#include <stdio.h>
#include <vector>
#include "linkcbor.h"

static int failures = 0;
static void check(const char *name, bool ok) {
	printf(ok ? "PASS %s\n" : "FAIL %s\n", name);
	if (!ok) failures++;
}

template <typename F> static std::vector<uint8_t> enc(F f) {
	uint8_t buf[64];
	LinkCborWriter w(buf, sizeof buf);
	f(w);
	return std::vector<uint8_t>(buf, buf + w.n);
}
static bool is(const std::vector<uint8_t> &got, std::vector<uint8_t> want) { return got == want; }

// {"x": <item>} with the item's bytes, read back as a number.
static bool num(std::vector<uint8_t> item, double &out) {
	std::vector<uint8_t> p = {0xA1, 0x61, 'x'};
	p.insert(p.end(), item.begin(), item.end());
	return linkCborNumber(p.data(), (uint8_t)p.size(), "x", out);
}

int main() {
	// Appendix A: integers in their shortest form.
	check("uint", is(enc([](LinkCborWriter &w) { w.u(0); w.u(23); w.u(24); w.u(100); w.u(1000); w.u(1000000); }),
		{0x00, 0x17, 0x18, 0x18, 0x18, 0x64, 0x19, 0x03, 0xE8, 0x1A, 0x00, 0x0F, 0x42, 0x40}));
	check("negative", is(enc([](LinkCborWriter &w) { w.i(-1); w.i(-10); w.i(-100); w.i(-1000); }), {0x20, 0x29, 0x38, 0x63, 0x39, 0x03, 0xE7}));
	check("int32-min", is(enc([](LinkCborWriter &w) { w.i(INT32_MIN); }), {0x3A, 0x7F, 0xFF, 0xFF, 0xFF}));
	// 100000.0 as single precision: fa 47 c3 50 00.
	check("float", is(enc([](LinkCborWriter &w) { w.f(100000.0f); }), {0xFA, 0x47, 0xC3, 0x50, 0x00}));
	// {"a": 1}: a1 61 61 01.
	check("map", is(enc([](LinkCborWriter &w) { w.map(1); w.key("a"); w.u(1); }), {0xA1, 0x61, 0x61, 0x01}));
	{
		uint8_t buf[4];
		LinkCborWriter w(buf, sizeof buf);
		w.map(1), w.key("abc"), w.u(1);
		check("overflow", !w.ok && w.n == 4);
	}

	// A message written by us and read back by name, in any order.
	{
		uint8_t buf[48];
		LinkCborWriter w(buf, sizeof buf);
		w.map(3), w.key("tempCx100"), w.i(-1234), w.key("rhx100"), w.u(4567), w.key("v"), w.f(3.25f);
		double t = 0, rh = 0, v = 0, none = 0;
		check("roundtrip", w.ok && linkCborNumber(buf, w.n, "rhx100", rh) && rh == 4567 && linkCborNumber(buf, w.n, "tempCx100", t) && t == -1234 &&
			linkCborNumber(buf, w.n, "v", v) && v == 3.25 && !linkCborNumber(buf, w.n, "temp", none));
		check("truncated", !linkCborNumber(buf, (uint8_t)(w.n - 1), "v", v));
	}

	// What another encoder may send: half and double floats (Appendix A), 8-byte integers.
	double d = 0;
	check("half", num({0xF9, 0x3E, 0x00}, d) && d == 1.5 && num({0xF9, 0xC4, 0x00}, d) && d == -4.0 && num({0xF9, 0x00, 0x01}, d) && fabs(d - 5.960464477539063e-8) < 1e-20);
	check("double", num({0xFB, 0x3F, 0xF1, 0x99, 0x99, 0x99, 0x99, 0x99, 0x9A}, d) && d == 1.1);
	check("uint64", num({0x1B, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00}, d) && d == 65536);
	// Not ours: an array, a text value, an indefinite map.
	{
		const uint8_t arr[] = {0x81, 0x01}, text[] = {0xA1, 0x61, 'x', 0x61, 'y'}, indef[] = {0xBF, 0x61, 'x', 0x01, 0xFF};
		check("not-ours", !linkCborNumber(arr, sizeof arr, "x", d) && !linkCborNumber(text, sizeof text, "x", d) && !linkCborNumber(indef, sizeof indef, "x", d));
	}
	return failures;
}
