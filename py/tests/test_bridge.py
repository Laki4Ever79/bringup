"""The bridge protocol end to end (bench.md §3b), against --source fake and --source replay. No hardware."""

import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
sys.path.insert(0, os.path.join(ROOT, "py"))

from test_bench_units import fw_dir  # noqa: E402

REPLAY_STUB = os.path.join(tempfile.mkdtemp(), "stub.jsonl")
with open(REPLAY_STUB, "w") as _f:
    _f.write(json.dumps({"k": "s", "at": 1, "rev": 1}) + "\n")


class Bridge:
    def __init__(self, *args):
        self.proc = subprocess.Popen(
            [sys.executable, "-B", os.path.join(ROOT, "py/bench.py"), *args],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        self.lines = queue.Queue()
        self.seen = []
        threading.Thread(target=self._read, daemon=True).start()
        self.next_id = 0

    def _read(self):
        for line in self.proc.stdout:
            self.lines.put(json.loads(line))
        self.lines.put(None)

    def until(self, pred, timeout=30.0, since=None):
        """The first line matching pred: from self.seen[since:] if given (lines an ack() already passed over), then
        from new output."""
        if since is not None:
            for m in self.seen[since:]:
                if pred(m):
                    return m
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            try:
                m = self.lines.get(timeout=max(0.01, end - time.monotonic()))
            except queue.Empty:
                break
            if m is None:
                raise AssertionError(f"bridge exited; stderr: {self.proc.stderr.read()}")
            self.seen.append(m)
            if pred(m):
                return m
        raise AssertionError(f"timed out; last lines: {self.seen[-5:]}")

    def send(self, cmd, **params):
        self.next_id += 1
        self.proc.stdin.write(json.dumps({"id": self.next_id, "cmd": cmd, **params}) + "\n")
        self.proc.stdin.flush()
        return self.next_id

    def ack(self, rid, timeout=30.0):
        return self.until(lambda m: m["k"] == "ack" and m["id"] == rid, timeout)

    def quit(self):
        rid = self.send("quit")
        self.ack(rid)
        self.until(lambda m: m["k"] == "bye")
        self.assert_exit()

    def assert_exit(self):
        code = self.proc.wait(timeout=30)
        assert code == 0, f"exit {code}; stderr: {self.proc.stderr.read()}"
        for f in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            if not f.closed:
                f.close()


class FakeSource(unittest.TestCase):
    def test_hello_flash_boot_telemetry_meter_mode_and_files(self):
        out = tempfile.mkdtemp()
        b = Bridge("--source", "fake", "--fake-speed", "20", "--out", out)
        hello = b.until(lambda m: True)
        self.assertEqual(hello["k"], "hello")
        self.assertEqual((hello["source"], hello["meter"]), ("fake", True))
        self.assertEqual(set(hello["ports"]), {"dut", "fixture", "telemetry"})
        self.assertIsInstance(hello["at"], int)

        mark = len(b.seen)
        rid = b.send("flash", dir=fw_dir(7))
        ack = b.ack(rid)
        self.assertTrue(ack["ok"], ack)
        stages = [m["stage"] for m in b.seen if m["k"] == "flashing" and m["id"] == rid]
        self.assertEqual(stages[0], "build")
        self.assertIn("connect", stages)
        self.assertEqual(stages[-1], "write")
        self.assertEqual([m["pct"] for m in b.seen if m["k"] == "flashing"][-1], 100)
        boot = b.until(lambda m: m["k"] == "boot", since=mark)
        self.assertEqual((boot["rev"], boot["mode"], boot["reset"]), (7, "live", "usb"))
        s = b.until(lambda m: m["k"] == "s")
        self.assertEqual(s["rev"], 7)
        i = b.until(lambda m: m["k"] == "i")
        self.assertGreater(i["mA"], 40)

        mark = len(b.seen)
        rid = b.send("mode", mode="duty")
        self.assertTrue(b.ack(rid)["ok"])
        cycle = b.until(lambda m: m["k"] == "cycle", since=mark)
        self.assertEqual(cycle["rev"], 7)
        floor = b.until(lambda m: m["k"] == "i" and m["mA"] < 10)
        self.assertAlmostEqual(floor["mA"], 6.0, delta=0.5)

        rid = b.send("recover")
        self.assertTrue(b.ack(rid)["ok"], "the fake DUT enumerates in download mode")
        mark = len(b.seen)
        rid = b.send("reset")
        self.assertTrue(b.ack(rid)["ok"])
        # The EN pulse's boot can land before or after the ack, and duty-cycle wakes may be queued around it.
        boot = b.until(lambda m: m["k"] == "boot" and m["reset"] != "deepsleep", since=mark)
        self.assertEqual(boot["reset"], "poweron")

        rid = b.send("ports")
        self.assertEqual(set(b.ack(rid)["ports"]), {"dut", "fixture", "telemetry"})
        rid = b.send("nonsense")
        self.assertFalse(b.ack(rid)["ok"])
        b.quit()

        with open(os.path.join(out, "bench.jsonl")) as f:
            recorded = [json.loads(l) for l in f]
        kinds = {m["k"] for m in recorded}
        self.assertTrue({"hello", "boot", "s", "i", "cycle", "flashing"} <= kinds, kinds)
        self.assertNotIn("ack", kinds)
        with open(os.path.join(out, "power.csv")) as f:
            rows = f.read().splitlines()
        self.assertEqual(rows[0], "at,mA")
        self.assertGreater(len(rows), 50)

    def test_a_dir_without_pins_h_fails_the_build_stage(self):
        b = Bridge("--source", "fake", "--fake-speed", "50")
        b.until(lambda m: m["k"] == "hello")
        ack = b.ack(b.send("flash", dir=tempfile.mkdtemp()))
        self.assertEqual((ack["ok"], ack["stage"]), (False, "build"))
        b.quit()

    def test_a_contract_pin_on_a_bench_pin_is_refused_before_flashing(self):
        d = fw_dir(8)
        with open(os.path.join(d, "include/pins.h"), "a") as f:
            f.write("#define PIN_BUTTON 4\n")
        b = Bridge("--source", "fake", "--fake-speed", "50")
        b.until(lambda m: m["k"] == "hello")
        ack = b.ack(b.send("flash", dir=d))
        self.assertEqual((ack["ok"], ack["stage"]), (False, "build"))
        self.assertIn("BUTTON uses GPIO4", ack["error"])
        b.quit()

    def test_closing_stdin_ends_the_bridge(self):
        b = Bridge("--source", "fake")
        b.until(lambda m: m["k"] == "hello")
        b.proc.stdin.close()
        b.until(lambda m: m["k"] == "bye")
        b.assert_exit()


class FakeTier1(unittest.TestCase):
    def test_no_meter_is_a_bench_without_the_fixture(self):
        b = Bridge("--source", "fake", "--no-meter", "--fake-speed", "50")
        hello = b.until(lambda m: m["k"] == "hello")
        self.assertEqual((hello["meter"], hello["ports"]["fixture"]), (False, None))
        self.assertTrue(hello["ports"]["dut"] and hello["ports"]["telemetry"])
        mark = len(b.seen)
        self.assertTrue(b.ack(b.send("flash", dir=fw_dir(5)))["ok"])
        self.assertEqual(b.until(lambda m: m["k"] == "boot", since=mark)["rev"], 5)
        self.assertEqual(b.until(lambda m: m["k"] == "s")["rev"], 5)
        for cmd, extra in (("mode", {"mode": "duty"}), ("recover", {}), ("reset", {})):
            ack = b.ack(b.send(cmd, **extra))
            self.assertEqual(ack["ok"], False, cmd)
            self.assertIn("no fixture", ack["error"])
        b.quit()
        self.assertFalse(any(m["k"] == "i" for m in b.seen), "no meter, no current lines")


class FakeBareS3(unittest.TestCase):
    def test_no_imu_with_no_meter_is_the_bare_s3(self):
        b = Bridge("--source", "fake", "--no-meter", "--no-imu", "--fake-speed", "50")
        hello = b.until(lambda m: m["k"] == "hello")
        self.assertFalse(hello["meter"])
        mark = len(b.seen)
        self.assertTrue(b.ack(b.send("flash", dir=fw_dir(9)))["ok"])
        err = b.until(lambda m: m["k"] == "err", since=mark)
        self.assertEqual((err["rev"], err["what"]), (9, "imu"))
        s = b.until(lambda m: m["k"] == "s" and m["rev"] == 9, since=mark)
        self.assertEqual((s["tilt"], s["tSrc"]), (0, "none"))
        b.quit()


class AsksTheHuman(unittest.TestCase):
    def test_a_factory_board_with_no_fixture_gets_button_instructions(self):
        # What happened on the real board, 30 Oct: the factory demo can't be reset into flashing mode from the laptop,
        # and after a button-entered flash the S3 stays in the bootloader until RST.
        b = Bridge("--source", "fake", "--no-meter", "--fake-factory", "--fake-speed", "20")
        b.until(lambda m: m["k"] == "hello")
        mark = len(b.seen)
        rid = b.send("flash", dir=fw_dir(4))
        ask = b.until(lambda m: m["k"] == "instruct" and m["action"] == "boot-reset")
        self.assertEqual(ask["id"], rid)
        self.assertIn("hold BOOT, tap RST, release BOOT", ask["text"])
        self.assertTrue(b.ack(b.send("fake.press", buttons="boot+rst"))["ok"], "answered while the flash waits")
        self.assertTrue(b.until(lambda m: m["k"] == "instruct" and m["action"] == "boot-reset" and "done" in m)["done"])
        b.until(lambda m: m["k"] == "flashing" and m["pct"] == 100)
        ask = b.until(lambda m: m["k"] == "instruct" and m["action"] == "reset")
        self.assertIn("Tap RST", ask["text"])
        b.ack(b.send("fake.press", buttons="rst"))
        self.assertTrue(b.until(lambda m: m["k"] == "instruct" and m["action"] == "reset" and "done" in m)["done"])
        ack = b.ack(rid)
        self.assertEqual((ack["ok"], ack["booted"]), (True, 4))
        self.assertEqual(b.until(lambda m: m["k"] == "boot" and m["rev"] == 4, since=mark)["reset"], "poweron")
        b.quit()

    def test_our_firmware_resets_itself_and_nobody_is_asked(self):
        b = Bridge("--source", "fake", "--no-meter", "--fake-speed", "20")
        b.until(lambda m: m["k"] == "hello")
        self.assertTrue(b.ack(b.send("flash", dir=fw_dir(5)))["ok"])
        mark = len(b.seen)
        ack = b.ack(b.send("flash", dir=fw_dir(6)))
        self.assertEqual((ack["ok"], ack["booted"]), (True, 6))
        self.assertFalse(any(m["k"] == "instruct" for m in b.seen))
        b.quit()

    def test_fake_press_is_refused_on_a_real_bench(self):
        b = Bridge("--source", "replay", "--replay", REPLAY_STUB)
        b.until(lambda m: m["k"] == "hello")
        self.assertFalse(b.ack(b.send("fake.press", buttons="rst"))["ok"])
        b.quit()


class ReplaySource(unittest.TestCase):
    def test_replays_a_recording_in_real_time_and_never_rewrites_the_revision(self):
        path = os.path.join(tempfile.mkdtemp(), "bench.jsonl")
        t0 = 1_700_000_000_000
        with open(path, "w") as f:
            f.write(json.dumps({"k": "hello", "at": t0, "source": "real", "ports": {}, "meter": True}) + "\n")
            f.write(json.dumps({"k": "boot", "at": t0 + 10, "rev": 12, "reset": "poweron", "mode": "live"}) + "\n")
            for n in range(20):
                f.write(json.dumps({"k": "i", "at": t0 + 20 + n * 17, "mA": 45.0}) + "\n")
            f.write(json.dumps({"k": "ack", "at": t0 + 400, "id": 1, "ok": True}) + "\n")
            f.write(json.dumps({"k": "flashing", "at": t0 + 390, "id": 1, "stage": "write", "pct": 100}) + "\n")
            f.write(json.dumps({"k": "s", "at": t0 + 400, "rev": 12, "tilt": 3.0}) + "\n")
        b = Bridge("--source", "replay", "--replay", path)
        hello = b.until(lambda m: m["k"] == "hello")
        self.assertEqual((hello["source"], hello["meter"]), ("replay", True))
        boot = b.until(lambda m: m["k"] == "boot")
        s = b.until(lambda m: m["k"] == "s")
        # Paced by the bridge's own clock (recorded 390 ms apart), not by when this test got to read the lines.
        self.assertGreaterEqual(s["at"] - boot["at"], 300, "played back at the recorded pace")
        self.assertEqual(s["rev"], 12)
        self.assertFalse(any(m["k"] in ("ack", "flashing") for m in b.seen), "a recording's command ids are not replayed")
        ack = b.ack(b.send("flash", dir="/nowhere"))
        self.assertEqual((ack["ok"], ack["simulated"]), (True, True))
        self.assertEqual(b.until(lambda m: m["k"] == "boot")["rev"], 12, "loops, rev as recorded")
        b.quit()


if __name__ == "__main__":
    unittest.main()
