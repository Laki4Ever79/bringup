"""The firmware-in-the-loop bridge and course (py/mech/drive.py), against fake firmwares in place of QEMU.
Run: .venv/bin/python -B -m unittest discover -s py/tests -p 'test_mech*.py'"""

import os
import socket
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mech.drive import run  # noqa: E402
from test_mech_model import SPEC  # noqa: E402

# A rover that can climb the 1 cm step: 80 mm wheels, a 40 mm caster and its weight over the axle (60 mm wheels can't:
# a rigid driven wheel with floor friction 0.6 climbs about 0.14 of its radius).
# com is the whole rover's (wheels and caster included): with the default 11.3 g wheels and 33 g caster it leaves the
# chassis body at x = 20 mm, z = 45 mm.
SPEC_DRIVE = dict(SPEC, edgeMm=10, driverPeakA=2.0, payloadG=20, speedMps=0.3, stopBeforeWallMm=150, com=[9.5, 0.0, 40.92])
SPEC_DRIVE["drive"] = dict(SPEC["drive"], wheelDiameterMm=80)
SPEC_DRIVE["caster"] = dict(SPEC["caster"], wheelMm=40)


def fake_firmware(policy, unix_path=None):
    """A TCP server standing in for QEMU's UART1: it speaks the firmware's side of SIM.md with `policy(distance)`."""
    # A Unix socket path, as QEMU serves it for the bridge (src/tools/drive.ts), or a TCP port.
    if unix_path:
        srv = socket.socket(socket.AF_UNIX)
        srv.bind(unix_path)
        port = unix_path
    else:
        srv = socket.socket()
        srv.bind(("127.0.0.1", 0))
        port = srv.getsockname()[1]
    srv.listen(1)

    def serve():
        conn, _ = srv.accept()
        f = conn.makefile("rw", newline="\n")
        if policy is None:  # never says anything
            threading.Event().wait(30)
            return
        state = {"turn_until": -1, "now": 0}
        distance = -1
        tick = 0
        try:
            while True:
                left, right = policy(distance, state)
                f.write(f"M {tick} {left:.3f} {right:.3f}\n")
                f.flush()
                tick += 1
                line = f.readline()
                if not line:
                    return
                parts = line.split()
                state["now"] = int(parts[1])
                distance = int(parts[2])
        except (OSError, ValueError):
            return

    threading.Thread(target=serve, daemon=True).start()
    return port


def blind(distance, state):
    return 0.9, 0.9


def careful(distance, state):
    if state["now"] < state["turn_until"]:
        return 0.9, -0.9
    if 0 <= distance < 400:
        state["turn_until"] = state["now"] + 700
        return 0.9, -0.9
    return 0.9, 0.9


def late(distance, state):
    """Turns away, but only 60 mm from the wall: no contact, yet closer than the brief's 150 mm."""
    if state["now"] < state["turn_until"]:
        return 0.9, -0.9
    if 0 <= distance < 60:
        state["turn_until"] = state["now"] + 700
        return 0.9, -0.9
    return 0.4, 0.4


class DriveTest(unittest.TestCase):
    def test_a_firmware_that_ignores_walls_fails_the_course(self):
        out = tempfile.mkdtemp()
        r = run(SPEC_DRIVE, fake_firmware(blind), out, course_s=12, firmware_wait_s=5)
        self.assertEqual(r["result"], "fail")
        self.assertIn("wall", r["reason"])

    def test_the_bridge_reaches_the_firmware_over_a_unix_socket_path(self):
        # QEMU serves the firmware's UART on a socket file in the run folder: no free-port race (pending-fixes, 11 Nov).
        out = tempfile.mkdtemp()
        r = run(SPEC_DRIVE, fake_firmware(careful, os.path.join(out, "uart1.sock")), out, course_s=12, firmware_wait_s=5)
        self.assertEqual(r["result"], "pass", r["reason"])

    def test_a_firmware_that_turns_at_walls_passes_crosses_the_edge_and_keeps_driving(self):
        out = tempfile.mkdtemp()
        r = run(SPEC_DRIVE, fake_firmware(careful), out, course_s=12, firmware_wait_s=5)
        self.assertEqual(r["result"], "pass", r)
        names = {s["name"]: s["pass"] for s in r["segments"]}
        self.assertTrue(names["edge crossed"] and names["no wall contact"] and names["turned away"] and names["kept driving"])
        self.assertTrue(os.path.exists(os.path.join(out, "trajectory.json")))

    def test_the_step_is_the_specs_edge_and_crossing_it_means_the_caster_got_over(self):
        with tempfile.TemporaryDirectory() as out:
            r = run(dict(SPEC_DRIVE, edgeMm=3), fake_firmware(blind), out, course_s=4)
        edge = next(s for s in r["segments"] if s["name"] == "edge crossed")
        self.assertIn("the step is 3 mm", edge["detail"])
        self.assertEqual(r["edgeMm"], 3)  # the run page labels its plot from drive.json alone
        self.assertTrue(edge["pass"], edge["detail"])

    def test_turning_away_closer_than_the_briefs_wall_distance_fails(self):
        with tempfile.TemporaryDirectory() as out:
            r = run(dict(SPEC_DRIVE, edgeMm=3), fake_firmware(late), out, course_s=12)
        seg = next(s for s in r["segments"] if s["name"] == "kept its distance")
        self.assertFalse(seg["pass"], seg["detail"])
        self.assertIn("150 mm", seg["detail"])

    def test_a_firmware_that_never_answers_is_not_run_and_the_bridge_stops(self):
        out = tempfile.mkdtemp()
        r = run(SPEC_DRIVE, fake_firmware(None), out, course_s=12, firmware_wait_s=2)
        self.assertEqual(r["result"], "not run")
        self.assertIn("didn't answer within 2 s", r["reason"])

    # Final review: an unknown driver peak (null in the spec) crashed the bridge after the whole course.
    def test_an_unknown_driver_peak_doesnt_crash_the_drive(self):
        out = tempfile.mkdtemp()
        r = run(dict(SPEC_DRIVE, driverPeakA=None), fake_firmware(careful), out, course_s=6, firmware_wait_s=5)
        self.assertIn(r["result"], ("pass", "fail"))
        peak = next(x for x in r["segments"] if x["name"] == "peak current")
        self.assertIn("unknown", peak["detail"])

    # Final review: "kept its distance" passed when the rover never drove toward anything it could see.
    def test_kept_its_distance_is_not_a_pass_when_it_never_drove_toward_anything(self):
        out = tempfile.mkdtemp()
        r = run(SPEC_DRIVE, fake_firmware(lambda d, s: (0.5, -0.5)), out, course_s=4, firmware_wait_s=5)
        seg = next(x for x in r["segments"] if x["name"] == "kept its distance")
        self.assertFalse(seg["pass"])
        self.assertIn("not tested", seg["detail"])

    # Final review: a brief with no edge gave MuJoCo a zero-height step.
    def test_a_brief_with_no_edge_has_no_step(self):
        from mech.drive import course_xml
        self.assertNotIn('name="step"', course_xml(0))
        self.assertIn('name="step"', course_xml(0.003))


if __name__ == "__main__":
    unittest.main()
