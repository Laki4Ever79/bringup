// The firmware's drivers on the host (src/tools/driver-tests.ts compiles and runs this after every firmware build):
// each driver the design uses, against a simulated chip that behaves as its datasheet says. Prints one line per test,
// "PASS <name>" or "FAIL <name>: <why>"; exits 1 when any failed. -DTEST_<DRIVER> picks the drivers.
#include <stdio.h>
#include <string.h>
#include <string>
#include "Arduino.h"
#include "Wire.h"
#if __has_include("hw_pins.h")
#include "hw_pins.h"
#endif
#include "drivers/sensirion.h"
#include "drivers/drv8833.h"
#include "drivers/vl53l0x.h"

static int failures = 0;
static std::string why;
#define EXPECT(cond, ...)                                       \
	do {                                                        \
		if (!(cond)) {                                          \
			char b[200];                                        \
			snprintf(b, sizeof b, __VA_ARGS__);                 \
			why = b;                                            \
			return false;                                       \
		}                                                       \
	} while (0)
static void run(const char *name, bool (*fn)()) {
	Wire.reset();
	host::nowUs() = 0;
	why.clear();
	if (fn()) printf("PASS %s\n", name);
	else {
		printf("FAIL %s: %s\n", name, why.c_str());
		failures++;
	}
}
static bool near(float a, float b, float tol) { return a - b < tol && b - a < tol; }
static bool sameBytes(const std::vector<uint8_t> &a, std::initializer_list<uint8_t> b) { return a == std::vector<uint8_t>(b); }

// A Sensirion chip: answers a measurement with T and RH words, each with its CRC, once the measurement time is over
// (a read before that is NACKed, as the real chip does).
struct SensirionChip : HostChip {
	uint16_t rawT = 0, rawRh = 0;
	bool corruptCrc = false;
	uint32_t measureUs;
	int64_t measuredAt = -1;
	explicit SensirionChip(uint32_t us) : measureUs(us) {}
	bool answer(size_t n, uint64_t now, std::vector<uint8_t> &out) {
		if (measuredAt < 0 || n != 6 || now < (uint64_t)measuredAt + measureUs) return false;
		uint8_t t[2] = {(uint8_t)(rawT >> 8), (uint8_t)rawT}, h[2] = {(uint8_t)(rawRh >> 8), (uint8_t)rawRh};
		out = {t[0], t[1], (uint8_t)(crc8(t, 2) ^ (corruptCrc ? 0x01 : 0)), h[0], h[1], crc8(h, 2)};
		measuredAt = -1;
		return true;
	}
};
struct Sht4xChip : SensirionChip {
	Sht4xChip() : SensirionChip(8300) {}
	bool onWrite(const std::vector<uint8_t> &b, uint64_t now) override {
		if (b.size() != 1 || b[0] != 0xFD) return false;  // only the high-repeatability measurement is modelled
		measuredAt = (int64_t)now;
		return true;
	}
	bool onRead(size_t n, uint64_t now, std::vector<uint8_t> &out) override { return answer(n, now, out); }
};
struct Shtc3Chip : SensirionChip {
	bool awake = false;
	uint64_t awakeAt = 0;
	Shtc3Chip() : SensirionChip(12100) {}
	bool onWrite(const std::vector<uint8_t> &b, uint64_t now) override {
		if (b.size() != 2) return false;
		const uint16_t cmd = (uint16_t)(b[0] << 8 | b[1]);
		if (cmd == 0x3517) {
			awake = true;
			awakeAt = now + 240;
			return true;
		}
		if (!awake || now < awakeAt) return false;  // asleep, or still waking: NACK
		if (cmd == 0xB098) {
			awake = false;
			return true;
		}
		if (cmd != 0x7866) return false;
		measuredAt = (int64_t)now;
		return true;
	}
	bool onRead(size_t n, uint64_t now, std::vector<uint8_t> &out) override { return awake && answer(n, now, out); }
};

static bool crcExample() {
	const uint8_t beef[2] = {0xBE, 0xEF};
	EXPECT(crc8(beef, 2) == 0x92, "crc8(0xBEEF) = 0x%02X, the datasheet says 0x92", crc8(beef, 2));
	return true;
}

#ifdef TEST_SHT40
static Sht4xChip sht;
static bool shtReads() {
	sht = Sht4xChip();
	sht.rawT = 26214;  // 25.00 °C
	sht.rawRh = 29360; // 50.00 %RH
	Wire.chips[0x44] = &sht;
	float t = 0, rh = 0;
	EXPECT(sht4xRead(&t, &rh), "the read failed");
	EXPECT(near(t, 25.0f, 0.01f) && near(rh, 50.0f, 0.01f), "read %.3f °C %.3f %%RH, the chip said 25 °C 50 %%RH", t, rh);
	EXPECT(!Wire.writes.empty() && Wire.writes[0].first == 0x44 && sameBytes(Wire.writes[0].second, {0xFD}), "the first write is not 0xFD to 0x44");
	return true;
}
static bool shtWaits() {
	sht = Sht4xChip();
	Wire.chips[0x44] = &sht;
	float t, rh;
	EXPECT(sht4xRead(&t, &rh), "the read came before the 8.3 ms measurement was done (the chip NACKed it)");
	return true;
}
static bool shtCrc() {
	sht = Sht4xChip();
	sht.corruptCrc = true;
	Wire.chips[0x44] = &sht;
	float t = 1234, rh = 1234;
	EXPECT(!sht4xRead(&t, &rh), "a reading with a wrong CRC was accepted (%.2f °C)", t);
	return true;
}
static bool shtCrops() {
	sht = Sht4xChip();
	sht.rawRh = 65535;  // -6 + 125 = 119 %RH before cropping
	Wire.chips[0x44] = &sht;
	float t, rh;
	EXPECT(sht4xRead(&t, &rh) && rh <= 100.0f, "humidity %.1f %% is over 100", rh);
	return true;
}
static bool shtAbsent() {
	float t, rh;
	EXPECT(!sht4xRead(&t, &rh), "a read with no chip on the bus succeeded");
	return true;
}
#endif

#ifdef TEST_SHTC3
static Shtc3Chip shc;
static bool shcSequence() {
	shc = Shtc3Chip();
	shc.rawT = 26214;  // -45 + 175·26214/65536 = 24.999 °C
	shc.rawRh = 32768; // 50 %RH
	Wire.chips[0x70] = &shc;
	float t = 0, rh = 0;
	EXPECT(shtc3Read(&t, &rh), "the read failed");
	EXPECT(near(t, 25.0f, 0.01f) && near(rh, 50.0f, 0.01f), "read %.3f °C %.3f %%RH", t, rh);
	EXPECT(Wire.writes.size() == 3 && sameBytes(Wire.writes[0].second, {0x35, 0x17}) && sameBytes(Wire.writes[1].second, {0x78, 0x66}) && sameBytes(Wire.writes[2].second, {0xB0, 0x98}), "not wakeup, measure, sleep (%zu writes)", Wire.writes.size());
	EXPECT(!shc.awake, "the chip was left awake");
	return true;
}
static bool shcCrc() {
	shc = Shtc3Chip();
	shc.corruptCrc = true;
	Wire.chips[0x70] = &shc;
	float t, rh;
	EXPECT(!shtc3Read(&t, &rh), "a reading with a wrong CRC was accepted");
	EXPECT(!shc.awake, "a failed read left the chip awake (0.3 µA asleep, far more awake)");
	return true;
}
#endif

#ifdef TEST_DRV8833
static bool drvForward() {
	Drv8833Levels l = drv8833Levels(0.5f, 1023);
	EXPECT(l.in1 == 511 && l.in2 == 0, "duty +0.5 drove IN1=%d IN2=%d; forward is IN1 PWM, IN2 low", l.in1, l.in2);
	return true;
}
static bool drvReverse() {
	Drv8833Levels l = drv8833Levels(-0.5f, 1023);
	EXPECT(l.in1 == 0 && l.in2 == 511, "duty -0.5 drove IN1=%d IN2=%d; reverse is IN1 low, IN2 PWM", l.in1, l.in2);
	return true;
}
static bool drvCoast() {
	Drv8833Levels l = drv8833Levels(0.0f, 1023);
	EXPECT(l.in1 == 0 && l.in2 == 0, "duty 0 drove IN1=%d IN2=%d; stopped is both low (coast)", l.in1, l.in2);
	Drv8833Levels n = drv8833Levels(NAN, 1023);
	EXPECT(n.in1 == 0 && n.in2 == 0, "a NaN duty drove IN1=%d IN2=%d", n.in1, n.in2);
	return true;
}
static bool drvClamps() {
	Drv8833Levels l = drv8833Levels(2.0f, 1023), r = drv8833Levels(-3.0f, 1023);
	EXPECT(l.in1 == 1023 && l.in2 == 0 && r.in1 == 0 && r.in2 == 1023, "duty past ±1 drove %d/%d and %d/%d", l.in1, l.in2, r.in1, r.in2);
	return true;
}
#endif

#ifdef TEST_VL53L0X
#ifndef ROVER_RANGE_MM
#define ROVER_RANGE_MM 1200
#endif
static bool tofRange() {
	EXPECT(tofDistanceMm(ROVER_RANGE_MM, false, ROVER_RANGE_MM) == -1, "a reading at the range limit (%d mm) counts as a wall", ROVER_RANGE_MM);
	EXPECT(tofDistanceMm(8190, false, ROVER_RANGE_MM) == -1, "the library's 8190 (no target) counts as a wall");
	EXPECT(tofDistanceMm(300, true, ROVER_RANGE_MM) == -1, "a timed-out reading counts as a wall");
	EXPECT(tofDistanceMm(300, false, ROVER_RANGE_MM) == 300, "a 300 mm reading came out as %d", tofDistanceMm(300, false, ROVER_RANGE_MM));
	return true;
}
#endif

int main() {
	run("sensirion crc matches the datasheet example", crcExample);
#ifdef TEST_SHT40
	run("sht40 reads the chip's temperature and humidity", shtReads);
	run("sht40 waits for its 8.3 ms measurement", shtWaits);
	run("sht40 crc rejects a corrupted reading", shtCrc);
	run("sht40 crops humidity to 100 %", shtCrops);
	run("sht40 reports no chip as a failed read", shtAbsent);
#endif
#ifdef TEST_SHTC3
	run("shtc3 wakes, measures and sleeps", shcSequence);
	run("shtc3 crc rejects a corrupted reading and sleeps", shcCrc);
#endif
#ifdef TEST_DRV8833
	run("drv8833 forward drives IN1", drvForward);
	run("drv8833 reverse drives IN2", drvReverse);
	run("drv8833 coast at zero", drvCoast);
	run("drv8833 clamps the duty", drvClamps);
#endif
#ifdef TEST_VL53L0X
	run("vl53l0x out of range is nothing ahead", tofRange);
#endif
	return failures ? 1 : 0;
}
