"""Telemetry over the S3's own USB port, shared with flashing (no CP2102). Run: .venv/bin/python -B -m unittest discover -s py/tests"""

import os
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from benchlib.ports import classify  # noqa: E402
from benchlib.telemetry import TelemetryReader  # noqa: E402


class SharedPort(unittest.TestCase):
    def test_without_a_cp2102_telemetry_comes_from_the_s3s_own_port(self):
        self.assertEqual(classify([("/dev/ttyACM0", 0x303A, 0x1001)]), {"dut": "/dev/ttyACM0", "fixture": None, "telemetry": "/dev/ttyACM0"})

    def test_a_cp2102_still_wins_when_present(self):
        found = classify([("/dev/ttyACM0", 0x303A, 0x1001), ("/dev/ttyUSB0", 0x10C4, 0xEA60)])
        self.assertEqual(found["telemetry"], "/dev/ttyUSB0")


class FakeSerial:
    def __init__(self, log, lines):
        self.log, self.lines = log, lines
        log.append("open")

    def readline(self):
        time.sleep(0.01)
        return self.lines.pop(0) if self.lines else b""

    def close(self):
        self.log.append("close")


def wait(pred, timeout=20.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.01)
    return False


class Reader(unittest.TestCase):
    def test_reads_lines_and_lets_go_of_the_port_while_paused(self):
        log, got = [], []
        lines = [b'{"k":"boot","rev":3}\n']
        r = TelemetryReader("/dev/ttyACM0", got.append, open_port=lambda p: FakeSerial(log, lines), retry_s=0.05)
        r.start()
        self.assertTrue(wait(lambda: got), "no line read")
        self.assertEqual(got[0], {"k": "boot", "rev": 3})
        r.pause()
        self.assertEqual(log[-1], "close", "the port is closed before pause() returns, so esptool can open it")
        n = len(log)
        time.sleep(0.15)
        self.assertEqual(len(log), n, "nothing reopens it while paused")
        lines.append(b"plain text\n")
        r.resume()
        self.assertTrue(wait(lambda: len(got) == 2))
        self.assertEqual(got[1], {"k": "text", "text": "plain text"})
        r.stop()

    def test_a_vanished_port_is_reported_once_and_retried(self):
        got, attempts = [], []

        def opener(p):
            attempts.append(1)
            if len(attempts) < 4:
                raise OSError("[Errno 2] could not open port")
            return FakeSerial([], [b'{"k":"s","rev":4}\n'])

        r = TelemetryReader("/dev/ttyACM0", got.append, open_port=opener, retry_s=0.02)
        r.start()
        self.assertTrue(wait(lambda: any(m.get("k") == "s" for m in got)))
        self.assertEqual(sum(1 for m in got if m.get("k") == "error"), 1, got)
        r.stop()


if __name__ == "__main__":
    unittest.main()


class FlashReleasesThePort(unittest.TestCase):
    def test_the_bridge_pauses_shared_telemetry_around_a_flash(self):
        import io
        from unittest import mock

        from benchlib import bridge as B
        from test_bench_units import fw_dir

        events = []

        class Spy:
            def pause(self):
                events.append("pause")

            def resume(self):
                events.append("resume")

        b = B.Bridge("real", B.Out(io.StringIO(), None), "pio")
        b.ports = {"dut": "/dev/ttyACM0", "fixture": None, "telemetry": "/dev/ttyACM0"}
        b.telemetry = Spy()

        def fake_flash(*a, **k):
            events.append("flash")
            return {"ok": True, "ms": 1}

        with mock.patch.object(B, "flash", fake_flash):
            self.assertTrue(b.cmd_flash(1, {"dir": fw_dir(3)})["ok"])
        self.assertEqual(events, ["pause", "flash", "resume"])

        def broken_flash(*a, **k):
            events.append("flash")
            raise RuntimeError("pio vanished")

        events.clear()
        with mock.patch.object(B, "flash", broken_flash):
            with self.assertRaises(RuntimeError):
                b.cmd_flash(2, {"dir": fw_dir(3)})
        self.assertEqual(events, ["pause", "flash", "resume"], "resumed even when the flash throws")

        events.clear()
        b.ports["telemetry"] = "/dev/ttyUSB0"  # a CP2102: nothing to release
        with mock.patch.object(B, "flash", fake_flash):
            b.cmd_flash(3, {"dir": fw_dir(3)})
        self.assertEqual(events, ["flash"])
