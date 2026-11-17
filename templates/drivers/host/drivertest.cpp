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
#include "drivers/lsm6ds3.h"

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

#ifdef TEST_LSM6DS3
// An LSM6DS3TR-C: a register file behind an address pointer, auto-incrementing (IF_INC); WHO_AM_I 0x6A; the yaw rate
// in OUTZ_L_G/OUTZ_H_G only once the gyro's ODR is set (power-down before: zeros).
struct Lsm6Chip : HostChip {
	uint8_t reg[0x80] = {};
	uint8_t ptr = 0;
	int16_t yaw = 0;
	Lsm6Chip() { reg[LSM6_WHO_AM_I] = LSM6_WHO; reg[LSM6_CTRL3_C] = 0x04; }
	bool onWrite(const std::vector<uint8_t> &b, uint64_t) override {
		if (b.empty()) return false;
		ptr = b[0];
		for (size_t i = 1; i < b.size(); i++) reg[(ptr + i - 1) & 0x7F] = b[i];
		return true;
	}
	bool onRead(size_t n, uint64_t, std::vector<uint8_t> &out) override {
		const bool on = (reg[LSM6_CTRL2_G] >> 4) != 0;
		reg[LSM6_OUTZ_L_G] = on ? (uint8_t)yaw : 0;
		reg[LSM6_OUTZ_L_G + 1] = on ? (uint8_t)((uint16_t)yaw >> 8) : 0;
		out.clear();
		for (size_t i = 0; i < n; i++) out.push_back(reg[(ptr + i) & 0x7F]);
		ptr = (uint8_t)(ptr + n);
		return true;
	}
};
static bool lsmBegins() {
	Lsm6Chip chip;
	Wire.chips[LSM6_ADDR] = &chip;
	EXPECT(lsm6Begin(), "lsm6Begin failed against a chip whose WHO_AM_I is 0x6A");
	EXPECT(chip.reg[LSM6_CTRL2_G] == 0x44, "CTRL2_G = 0x%02X; 104 Hz at +/-500 dps is 0x44", chip.reg[LSM6_CTRL2_G]);
	EXPECT(chip.reg[LSM6_CTRL3_C] == 0x44, "CTRL3_C = 0x%02X; BDU with IF_INC is 0x44", chip.reg[LSM6_CTRL3_C]);
	EXPECT(host::nowUs() >= 35000, "it read on before the gyro's 35 ms turn-on time");
	return true;
}
static bool lsmRefusesAnotherChip() {
	Lsm6Chip chip;
	chip.reg[LSM6_WHO_AM_I] = 0x69;  // an LSM6DS3 (not TR-C) or anything else
	Wire.chips[LSM6_ADDR] = &chip;
	EXPECT(!lsm6Begin(), "lsm6Begin accepted WHO_AM_I 0x69");
	Wire.reset();
	EXPECT(!lsm6Begin(), "lsm6Begin succeeded with no chip on the bus");
	return true;
}
static bool lsmYaw() {
	Lsm6Chip chip;
	Wire.chips[LSM6_ADDR] = &chip;
	lsm6Begin();
	chip.yaw = 5143;  // 5143 x 17.5 mdps = 90.0 dps
	float dps = 0;
	EXPECT(lsm6YawDps(&dps) && near(dps, 90.0f, 0.01f), "5143 LSB read as %.3f dps; 17.5 mdps/LSB gives 90.0", dps);
	chip.yaw = -5143;
	EXPECT(lsm6YawDps(&dps) && near(dps, -90.0f, 0.01f), "-5143 LSB read as %.3f dps", dps);
	return true;
}
// 90 dps for 1 s turns pi/2; a 0.5 dps bias measured at rest is taken off, so standing still stays at 0.
static bool lsmHeading() {
	GyroHeading h;
	for (uint32_t t = 0; t <= 1000000; t += 10000) gyroHeadingStep(h, 90.0f, t);
	EXPECT(near(h.rad, (float)M_PI / 2, 0.001f), "90 dps for 1 s came to %.4f rad, pi/2 is 1.5708", h.rad);
	GyroHeading still;
	still.biasDps = 0.5f;
	for (uint32_t t = 0; t <= 10000000; t += 10000) gyroHeadingStep(still, 0.5f, t);
	EXPECT(near(still.rad, 0.0f, 1e-6f), "a 0.5 dps bias drifted to %.5f rad in 10 s", still.rad);
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
#ifdef TEST_LSM6DS3
	run("lsm6ds3 begins: WHO_AM_I, 104 Hz at +/-500 dps, BDU, turn-on time", lsmBegins);
	run("lsm6ds3 refuses another chip or none", lsmRefusesAnotherChip);
	run("lsm6ds3 reads the yaw rate at 17.5 mdps/LSB", lsmYaw);
	run("gyro heading integrates and takes off the bias", lsmHeading);
#endif
	return failures ? 1 : 0;
}
