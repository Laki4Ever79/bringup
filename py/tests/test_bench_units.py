"""Unit tests for the bench bridge pieces that need no hardware. Run: .venv/bin/python -B -m unittest discover -s py/tests"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from benchlib.fixture_fw.ina226 import INA226, REG_BUS, REG_CAL, REG_CONFIG, REG_CURRENT  # noqa: E402
from benchlib.ports import classify  # noqa: E402
from benchlib.flash import FlashProgress, bench_pin_conflicts, flash, read_firmware_info, stage_build_dir  # noqa: E402
from benchlib.fakedut import FakeDut  # noqa: E402


class FakeI2C:
    """INA226 registers in memory; records every config write."""

    def __init__(self):
        self.regs = {REG_BUS: 4000, REG_CURRENT: 2000}
        self.configs = []

    def writeto_mem(self, addr, reg, data):
        value = (data[0] << 8) | data[1]
        self.regs[reg] = value
        if reg == REG_CONFIG:
            self.configs.append(value)

    def readfrom_mem(self, addr, reg, n):
        v = self.regs.get(reg, 0)
        return bytes([(v >> 8) & 0xFF, v & 0xFF])


class Ina226ShuntOnly(unittest.TestCase):
    def test_reads_the_bus_once_then_converts_the_shunt_continuously(self):
        i2c = FakeI2C()
        ina = INA226(i2c, 0x40, 0.1, 0.8)
        self.assertEqual(i2c.configs[-1] & 0b111, 0b101, "continuous, shunt only")
        self.assertEqual((i2c.configs[-1] >> 3) & 0b111, 0b100, "shunt conversion 1.1 ms")
        self.assertEqual((i2c.configs[-1] >> 9) & 0b111, 0b010, "16 averages")
        self.assertEqual(i2c.configs[0] & 0b111, 0b011, "one triggered shunt+bus conversion first")
        self.assertEqual(i2c.regs[REG_CAL], 2048)
        i2c.regs[REG_BUS] = 0  # a stale bus register must not leak into readings
        r = ina.read()
        self.assertEqual(r["bus_v"], 5.0)
        self.assertAlmostEqual(r["current_a"], 0.05)

    def test_shunt_and_bus_mode_is_still_available(self):
        i2c = FakeI2C()
        INA226(i2c, 0x40, 0.1, 0.8, shunt_only=False)
        self.assertEqual(i2c.configs, [0x4000 | (0b010 << 9) | (0b100 << 6) | (0b100 << 3) | 0b111])


class Ports(unittest.TestCase):
    def test_classifies_by_vid_pid(self):
        found = classify([
            ("/dev/ttyACM0", 0x2E8A, 0x0005),
            ("/dev/ttyUSB0", 0x10C4, 0xEA60),
            ("/dev/ttyACM1", 0x303A, 0x1001),
            ("/dev/ttyACM2", 0x1A86, 0x55D3),
        ])
        self.assertEqual(found, {"dut": "/dev/ttyACM1", "fixture": "/dev/ttyACM0", "telemetry": "/dev/ttyUSB0"})

    def test_missing_devices_are_null(self):
        self.assertEqual(classify([]), {"dut": None, "fixture": None, "telemetry": None})


def esptool_lines():
    return [
        "Processing esp32s3_bench (platform: espressif32; board: esp32-s3-devkitc-1; framework: arduino)",
        "Compiling .pio/build/esp32s3_bench/src/main.cpp.o",
        "Linking .pio/build/esp32s3_bench/firmware.elf",
        "Configuring upload protocol...",
        "Uploading .pio/build/esp32s3_bench/firmware.bin",
        "Connecting...",
        "Writing at 0x00000000... (100 %)",
        "Writing at 0x00008000... (100 %)",
        "Writing at 0x00010000... (3 %)",
        "Writing at 0x00014000... (7 %)",
        "Writing at 0x00020000... (15 %)",
        "Writing at 0x00030000... (26 %)",
        "Writing at 0x00040000... (31 %)",
        "Writing at 0x00090000... (100 %)",
        "Hard resetting via RTS pin...",
    ]


class Progress(unittest.TestCase):
    def test_stages_and_app_write_steps(self):
        p = FlashProgress()
        events = [e for line in esptool_lines() for e in p.feed(line)]
        self.assertEqual(events, [
            {"stage": "build", "pct": 0},
            {"stage": "connect", "pct": 0},
            {"stage": "write", "pct": 3},
            {"stage": "write", "pct": 15},
            {"stage": "write", "pct": 26},
            {"stage": "write", "pct": 100},
        ])

    def test_failure_stage(self):
        p = FlashProgress()
        for line in esptool_lines()[:5]:
            p.feed(line)
        self.assertEqual(p.failure_stage("A fatal error occurred: Failed to connect to ESP32-S3: No serial data received."), "connect")
        self.assertEqual(FlashProgress().failure_stage("src/main.cpp:12: error: expected ';'"), "build")
        self.assertEqual(p.failure_stage("could not open port '/dev/ttyACM0': [Errno 13] Permission denied"), "permission")
        w = FlashProgress()
        for line in esptool_lines()[:10]:
            w.feed(line)
        self.assertEqual(w.failure_stage("A fatal error occurred: Packet content transfer stopped"), "write")


def fw_dir(rev=7, behavior=True):
    d = tempfile.mkdtemp()
    os.makedirs(os.path.join(d, "include"))
    with open(os.path.join(d, "include/pins.h"), "w") as f:
        f.write(f"#pragma once\n#define PIN_I2C_SDA 8\n#define BRINGUP_REVISION {rev}\n")
    if behavior:
        with open(os.path.join(d, "include/behavior.h"), "w") as f:
            f.write("#pragma once\n#define BEHAVIOR_BLINK_MS 1000\n#define BEHAVIOR_TILT_BLINK_MS 100\n#define BEHAVIOR_TILT_DEG 20\n")
    return d


class FirmwareInfo(unittest.TestCase):
    def test_reads_revision_and_behavior(self):
        self.assertEqual(read_firmware_info(fw_dir(7)), {"rev": 7, "blinkMs": 1000, "tiltBlinkMs": 100, "tiltDeg": 20})

    def test_behavior_defaults(self):
        self.assertEqual(read_firmware_info(fw_dir(3, behavior=False)), {"rev": 3, "blinkMs": 1000, "tiltBlinkMs": 1000, "tiltDeg": 90})


class BenchPins(unittest.TestCase):
    def test_the_logger_contract_fits_the_bench(self):
        self.assertEqual(bench_pin_conflicts(fw_dir(7)), [])

    def test_contract_pins_on_bench_or_reserved_s3_pins_are_refused(self):
        d = fw_dir(7)
        with open(os.path.join(d, "include/pins.h"), "a") as f:
            f.write("#define PIN_BUTTON 4\n#define PIN_BUZZER 17\n#define PIN_X 36\n#define PIN_Y 48\n")
        conflicts = bench_pin_conflicts(d)
        self.assertEqual(len(conflicts), 4, conflicts)
        self.assertIn("BUTTON uses GPIO4", conflicts[0])
        self.assertIn("BENCH_MODE", conflicts[0])
        self.assertIn("GPIO17", conflicts[1])
        self.assertIn("PSRAM", conflicts[2])
        self.assertIn("onboard RGB LED", conflicts[3])


class StageBuildDir(unittest.TestCase):
    def test_copies_the_sources_into_one_work_dir_and_keeps_its_build_cache(self):
        work = tempfile.mkdtemp()
        os.makedirs(os.path.join(work, ".pio/build"))
        src = fw_dir(7)
        os.makedirs(os.path.join(src, "src"))
        with open(os.path.join(src, "src/main.cpp"), "w") as f:
            f.write("int x;\n")
        with open(os.path.join(src, "platformio.ini"), "w") as f:
            f.write("[env:esp32s3_bench]\n")
        stage_build_dir(src, work)
        mtime = os.path.getmtime(os.path.join(work, "src/main.cpp"))
        self.assertTrue(os.path.isdir(os.path.join(work, ".pio/build")), "the incremental build cache survives")
        with open(os.path.join(src, "include/pins.h"), "a") as f:
            f.write("#define PIN_LED 10\n")
        os.utime(os.path.join(src, "src/main.cpp"), (mtime + 100, mtime + 100))
        stage_build_dir(src, work)
        with open(os.path.join(work, "include/pins.h")) as f:
            self.assertIn("PIN_LED", f.read())
        self.assertEqual(os.path.getmtime(os.path.join(work, "src/main.cpp")), mtime, "unchanged files keep their mtime, so they don't recompile")


class Flash(unittest.TestCase):
    def runner(self, results):
        calls = []

        def run(cmd, on_line):
            calls.append(cmd)
            code, lines = results.pop(0)
            for line in lines:
                on_line(line)
            return code

        return run, calls

    def test_recovers_once_after_a_failed_connect(self):
        run, calls = self.runner([
            (1, esptool_lines()[:6] + ["A fatal error occurred: Failed to connect to ESP32-S3: No serial data received."]),
            (0, esptool_lines()),
        ])
        recovered, progress = [], []
        r = flash("/fw", "esp32s3_bench", port=lambda: "/dev/ttyACM1", run=run, recover=lambda: recovered.append(1) or True, on_progress=progress.append, pio="pio")
        self.assertTrue(r["ok"], r)
        self.assertEqual(len(recovered), 1)
        self.assertEqual(calls[0], ["pio", "run", "-d", "/fw", "-e", "esp32s3_bench", "-t", "upload", "--upload-port", "/dev/ttyACM1"])
        self.assertEqual(len(calls), 2)
        self.assertEqual(progress[-1], {"stage": "write", "pct": 100})

    def test_a_build_error_is_not_retried(self):
        run, calls = self.runner([(1, ["src/main.cpp:12: error: expected ';'"])])
        r = flash("/fw", "esp32s3_bench", port=lambda: "/dev/ttyACM1", run=run, recover=lambda: True, on_progress=lambda e: None, pio="pio")
        self.assertEqual((r["ok"], r["stage"], len(calls)), (False, "build", 1))
        self.assertIn("expected ';'", r["error"])

    def test_permission_denied_says_how_to_fix_it(self):
        run, calls = self.runner([(1, esptool_lines()[:5] + ["could not open port '/dev/ttyACM1': [Errno 13] Permission denied"])])
        r = flash("/fw", "esp32s3_bench", port=lambda: "/dev/ttyACM1", run=run, recover=lambda: True, on_progress=lambda e: None, pio="pio")
        self.assertEqual((r["ok"], r["stage"], len(calls)), (False, "permission", 1))
        self.assertIn("usermod -aG dialout", r["error"])

    def test_no_port_tries_recovery_then_gives_up(self):
        recovered = []
        r = flash("/fw", "esp32s3_bench", port=lambda: None, run=lambda c, o: 0, recover=lambda: recovered.append(1) or False, on_progress=lambda e: None, pio="pio")
        self.assertEqual((r["ok"], r["stage"], len(recovered)), (False, "connect", 1))
        self.assertIn("303a:1001", r["error"])


class Pins:
    """Fixture pins as the fake DUT sees them."""

    def __init__(self):
        self.levels = {}

    def get(self, pin, default):
        return self.levels.get(pin, default)


def lines_of(dut, kind):
    return [json.loads(l) for l in dut.drain_lines() if l.startswith("{") and json.loads(l).get("k") == kind]


class FakeDutTests(unittest.TestCase):
    def test_boots_live_with_the_flashed_revision_and_blinks_faster_when_tilted(self):
        pins = Pins()
        dut = FakeDut(pins, now_ms=0)
        dut.flash({"rev": 9, "blinkMs": 1000, "tiltBlinkMs": 100, "tiltDeg": 20}, now_ms=0)
        boot = lines_of(dut, "boot")
        self.assertEqual(boot, [{"k": "boot", "rev": 9, "reset": "usb", "mode": "live"}])
        toggles, last = {"flat": 0, "tilted": 0}, None
        for t in range(0, 8000, 10):
            dut.step(t)
            for s in lines_of(dut, "s"):
                self.assertEqual(s["rev"], 9)
                if last is not None and s["led"] != last:
                    toggles["tilted" if abs(s["tilt"]) > 20 else "flat"] += 1
                last = s["led"]
        self.assertGreater(toggles["tilted"], toggles["flat"] * 2, toggles)

    def test_duty_mode_wakes_every_3_s_and_draws_charge_over_the_floor(self):
        pins = Pins()
        pins.levels[12] = 1
        dut = FakeDut(pins, now_ms=0)
        dut.flash({"rev": 4, "blinkMs": 1000, "tiltBlinkMs": 1000, "tiltDeg": 90}, now_ms=0)
        currents = []
        for t in range(0, 15000, 5):
            dut.step(t)
            currents.append(dut.current_ma(t))
        cycles = lines_of(dut, "cycle")
        self.assertGreaterEqual(len(cycles), 4)
        self.assertTrue(all(c["rev"] == 4 and c["awakeMs"] > 0 for c in cycles))
        self.assertAlmostEqual(min(currents), 6.0, delta=0.5)
        self.assertGreater(max(currents), 50)

    def test_boot_pin_low_during_reset_enters_download_mode(self):
        pins = Pins()
        dut = FakeDut(pins, now_ms=0)
        self.assertEqual(dut.drain_lines(), [], "a blank board says nothing")
        dut.flash({"rev": 2, "blinkMs": 1000, "tiltBlinkMs": 1000, "tiltDeg": 90}, now_ms=0)
        dut.drain_lines()
        pins.levels[11] = 0
        dut.reset(now_ms=100)
        self.assertTrue(dut.download_mode)
        self.assertEqual(lines_of(dut, "boot"), [])
        pins.levels[11] = 1
        dut.reset(now_ms=200)
        self.assertFalse(dut.download_mode)
        self.assertEqual(lines_of(dut, "boot")[0]["reset"], "poweron")


if __name__ == "__main__":
    unittest.main()
