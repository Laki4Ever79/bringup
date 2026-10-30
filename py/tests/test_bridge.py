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

    def until(self, pred, timeout=8.0):
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

    def ack(self, rid, timeout=8.0):
        return self.until(lambda m: m["k"] == "ack" and m["id"] == rid, timeout)

    def quit(self):
        rid = self.send("quit")
        self.ack(rid)
        self.until(lambda m: m["k"] == "bye")
        self.assert_exit()

    def assert_exit(self):
        assert self.proc.wait(timeout=5) == 0
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

        rid = b.send("flash", dir=fw_dir(7))
        ack = b.ack(rid)
        self.assertTrue(ack["ok"], ack)
        stages = [m["stage"] for m in b.seen if m["k"] == "flashing" and m["id"] == rid]
        self.assertEqual(stages[0], "build")
        self.assertIn("connect", stages)
        self.assertEqual(stages[-1], "write")
        self.assertEqual([m["pct"] for m in b.seen if m["k"] == "flashing"][-1], 100)
        boot = b.until(lambda m: m["k"] == "boot")
        self.assertEqual((boot["rev"], boot["mode"]), (7, "live"))
        s = b.until(lambda m: m["k"] == "s")
        self.assertEqual(s["rev"], 7)
        i = b.until(lambda m: m["k"] == "i")
        self.assertGreater(i["mA"], 40)

        rid = b.send("mode", mode="duty")
        self.assertTrue(b.ack(rid)["ok"])
        cycle = b.until(lambda m: m["k"] == "cycle", timeout=6)
        self.assertEqual(cycle["rev"], 7)
        floor = b.until(lambda m: m["k"] == "i" and m["mA"] < 10, timeout=6)
        self.assertAlmostEqual(floor["mA"], 6.0, delta=0.5)

        rid = b.send("recover")
        self.assertTrue(b.ack(rid)["ok"], "the fake DUT enumerates in download mode")
        rid = b.send("reset")
        self.assertTrue(b.ack(rid)["ok"])
        self.assertEqual(b.until(lambda m: m["k"] == "boot")["reset"], "sw")

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

    def test_closing_stdin_ends_the_bridge(self):
        b = Bridge("--source", "fake")
        b.until(lambda m: m["k"] == "hello")
        b.proc.stdin.close()
        b.until(lambda m: m["k"] == "bye")
        b.assert_exit()


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
            f.write(json.dumps({"k": "s", "at": t0 + 400, "rev": 12, "tilt": 3.0}) + "\n")
        b = Bridge("--source", "replay", "--replay", path)
        hello = b.until(lambda m: m["k"] == "hello")
        self.assertEqual((hello["source"], hello["meter"]), ("replay", True))
        start = time.time() * 1000
        s = b.until(lambda m: m["k"] == "s")
        self.assertGreaterEqual(s["at"] - start, 250, "played back at the recorded pace")
        self.assertEqual(s["rev"], 12)
        self.assertFalse(any(m["k"] == "ack" for m in b.seen), "acks in a recording are not replayed")
        ack = b.ack(b.send("flash", dir="/nowhere"))
        self.assertEqual((ack["ok"], ack["simulated"]), (True, True))
        self.assertEqual(b.until(lambda m: m["k"] == "boot", timeout=4)["rev"], 12, "loops, rev as recorded")
        b.quit()


if __name__ == "__main__":
    unittest.main()
