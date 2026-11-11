// Runs linkframe.h on the host: one line per case, PASS <name> or FAIL <name>: <why>; exit code = failures.
#include <stdio.h>
#include <vector>
#include "linkframe.h"

struct Bytes : public Print {
	std::vector<uint8_t> v;
	size_t write(uint8_t c) override {
		v.push_back(c);
		return 1;
	}
	using Print::write;
};

struct Got {
	uint32_t hash;
	std::vector<uint8_t> payload;
};

static std::vector<Got> feedAll(LinkFrameReader &r, const std::vector<uint8_t> &in) {
	std::vector<Got> out;
	for (uint8_t b : in) {
		uint32_t hash;
		const uint8_t *p;
		uint8_t len;
		if (r.feed(b, hash, p, len)) out.push_back({hash, std::vector<uint8_t>(p, p + len)});
	}
	return out;
}

static std::vector<uint8_t> frame(uint32_t hash, const std::vector<uint8_t> &payload) {
	Bytes b;
	linkFrameWrite(b, hash, payload.data(), (uint8_t)payload.size());
	return b.v;
}

static int failures = 0;
static void check(const char *name, bool ok, const char *why) {
	if (ok) printf("PASS %s\n", name);
	else {
		printf("FAIL %s: %s\n", name, why);
		failures++;
	}
}
static bool one(const std::vector<Got> &g, uint32_t hash, const std::vector<uint8_t> &p) { return g.size() == 1 && g[0].hash == hash && g[0].payload == p; }

int main() {
	const std::vector<uint8_t> four = {1, 2, 3, 4};
	const uint32_t H = 0x1234abcd;
	{
		LinkFrameReader r;
		check("roundtrip", one(feedAll(r, frame(H, four)), H, four), "the frame didn't come back equal");
	}
	{
		LinkFrameReader r;
		std::vector<uint8_t> in = {0x00, 0xA5, 0x00, 0xFF};
		auto f = frame(H, four);
		in.insert(in.end(), f.begin(), f.end());
		check("garbage-before", one(feedAll(r, in), H, four), "no resync after garbage");
	}
	{
		LinkFrameReader r;
		auto f = frame(H, four);
		auto first = feedAll(r, std::vector<uint8_t>(f.begin(), f.begin() + 5));
		auto rest = feedAll(r, std::vector<uint8_t>(f.begin() + 5, f.end()));
		check("split", first.empty() && one(rest, H, four), "a frame fed in two parts wasn't read once");
	}
	{
		LinkFrameReader r;
		auto bad = frame(H, four);
		bad.back() ^= 0xFF;
		auto good = frame(H + 1, four);
		bad.insert(bad.end(), good.begin(), good.end());
		check("bad-checksum", one(feedAll(r, bad), H + 1, four), "a bad frame was read, or the next good one wasn't");
	}
	{
		LinkFrameReader r;
		std::vector<uint8_t> in = {0xA5, 0x5A, 1, 2, 3, 4, 49};
		in.resize(in.size() + 50, 0x11);
		auto good = frame(H, four);
		in.insert(in.end(), good.begin(), good.end());
		check("too-long", one(feedAll(r, in), H, four), "an over-long frame was read, or the next good one wasn't");
	}
	{
		LinkFrameReader r;
		std::vector<uint8_t> big(LINK_MAX_PAYLOAD);
		for (size_t i = 0; i < big.size(); i++) big[i] = (uint8_t)(i * 7);
		check("max-payload", one(feedAll(r, frame(H, big)), H, big), "the largest payload didn't round-trip");
	}
	{
		LinkFrameReader r;
		auto a = frame(H, four), b = frame(H + 2, {9});
		a.insert(a.end(), b.begin(), b.end());
		auto g = feedAll(r, a);
		check("back-to-back", g.size() == 2 && g[0].payload == four && g[1].hash == H + 2 && g[1].payload == std::vector<uint8_t>{9}, "two frames in one buffer weren't both read");
	}
	return failures;
}
