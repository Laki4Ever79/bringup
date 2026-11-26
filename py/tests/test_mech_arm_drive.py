"""The arm's firmware-in-the-loop bridge (py/mech/arm_drive.py) against a fake firmware and a toy model: the protocol,
the drop detection, the landed/missed verdict and the new cube each cycle. The real arm model is py/mech/arm_model.py's.
Run: .venv/bin/python -B -m unittest discover -s py/tests -p 'test_mech*.py'"""

import json
import os
import socket
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mech.arm_drive import grip_target, landed, run, with_model_defaults  # noqa: E402

JOINTS = ["base-yaw", "shoulder", "elbow", "wrist-pitch", "wrist-roll"]

# A toy arm: five hinges in a chain of small bodies and a sliding finger, each with a position actuator named as the real
# model's; a free 25 mm cube, starting in the air; the cup is only its numbers (the floor inside its radius).
TOY = """<mujoco>
  <option timestep="0.002"/>
  <default><joint damping="0.5" armature="0.01"/></default>
  <worldbody>
    <geom name="floor" type="plane" size="1 1 0.1"/>
    <body name="base" pos="-0.3 0 0.05">
""" + "".join(f'      <body name="l{i}" pos="0 0 0.02"><joint name="{j}" type="hinge" axis="0 0 1"/><geom type="box" size="0.01 0.01 0.01" mass="0.01"/>\n' for i, j in enumerate(JOINTS)) + """
      <body name="finger"><joint name="finger" type="slide" axis="1 0 0" range="0 0.04"/><geom type="box" size="0.005 0.005 0.005" mass="0.005"/></body>
""" + "      </body>\n" * len(JOINTS) + """    </body>
    <body name="cube" pos="0.16 0.125 0.08"><freejoint/><geom type="box" size="0.0125 0.0125 0.0125" mass="0.05"/></body>
  </worldbody>
  <actuator>
""" + "".join(f'    <position name="{j}" joint="{j}" kp="5"/>\n' for j in JOINTS) + """    <position name="gripper" joint="finger" kp="5"/>
  </actuator>
</mujoco>"""

CUP = {"xMm": 160, "yMm": 125, "innerRMm": 35, "rimZMm": 60}
GRIP = {"closedDeg": 0, "openDeg": 90, "closedQ": 0.0, "openQ": 0.04}


def fake_firmware(unix_path, ticks, grip_deg):
    """QEMU's UART1 stand-in: `ticks` lock-step ticks of "A" lines with the gripper at grip_deg, then "E"."""
    srv = socket.socket(socket.AF_UNIX)
    srv.bind(unix_path)
    srv.listen(1)
    seen = []

    def serve():
        c, _ = srv.accept()
        f = c.makefile("rw", newline="\n")
        for t in range(ticks):
            f.write(f"A {t} 10.00 20.00 -30.00 -80.00 0.00 {grip_deg:.2f}\n")
            f.flush()
            seen.append(f.readline().split())
        f.write(f"E {ticks}\n")
        f.flush()
        c.close()
        srv.close()

    th = threading.Thread(target=serve, daemon=True)
    th.start()
    return th, seen


class ArmDriveTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.mjcf = os.path.join(self.dir, "toy.xml")
        with open(self.mjcf, "w") as f:
            f.write(TOY)

    def drive(self, spawn, grip_deg, ticks=200):
        spec = {"mjcf": self.mjcf, "joints": JOINTS, "gripper": GRIP, "periodMs": 20, "repeats": 5, "spawn": spawn, "cup": CUP}
        sock = os.path.join(self.dir, "u.sock")
        th, seen = fake_firmware(sock, ticks, grip_deg)
        r = run(spec, sock, self.dir, firmware_wait_s=5, tick_wait_s=5)
        th.join(5)
        with open(os.path.join(self.dir, "arm.json")) as f:
            self.assertEqual(json.load(f), r)
        return r, seen

    def test_every_cube_dropped_in_the_cup_lands(self):
        # Each new cube appears above the cup and falls in: five drops in 4 s, each counted, each landed.
        r, seen = self.drive([160, 125, 80], 90)
        self.assertEqual(r["result"], "pass", r)
        self.assertGreaterEqual(r["landed"], 5)
        self.assertLess(r["worstMm"], 5)
        # Lock-step: one "S <ms>" per tick, 20 ms apart.
        self.assertEqual([s[0] for s in seen[:3]], ["S", "S", "S"])
        self.assertEqual(int(seen[1][1]) - int(seen[0][1]), 20)

    def test_without_a_spawn_new_cubes_go_where_the_model_put_the_first(self):
        # The toy's cube starts over the cup: every replacement does too.
        r, _ = self.drive(None, 90)
        self.assertEqual(r["result"], "pass", r)

    def test_cubes_beside_the_cup_miss(self):
        r, _ = self.drive([300, 125, 80], 90)
        self.assertEqual(r["result"], "fail")
        self.assertEqual(r["landed"], 1, "only the model's first cube, which starts over the cup")
        self.assertIn("cubes landed in the cup", r["reason"])

    def test_a_closed_gripper_drops_nothing(self):
        r, _ = self.drive([160, 125, 80], 0)
        self.assertEqual(r["result"], "fail")
        self.assertEqual(r["attempts"], 0)
        self.assertIn("were dropped before the firmware ended", r["reason"])

    def test_an_unstable_model_fails_loudly(self):
        # Joints with no damping or armature under stiff actuators blow up: MuJoCo resets, which must not read as a run.
        with open(self.mjcf, "w") as f:
            f.write(TOY.replace('<default><joint damping="0.5" armature="0.01"/></default>', "").replace('kp="5"', 'kp="5000"'))
        r, _ = self.drive([160, 125, 80], 90, ticks=20)
        self.assertEqual(r["result"], "fail")
        self.assertIn("unstable", r["reason"])

    def test_no_firmware_is_not_run(self):
        spec = {"mjcf": self.mjcf, "joints": JOINTS, "gripper": GRIP, "periodMs": 20, "repeats": 5, "spawn": [0, 0, 0], "cup": CUP}
        r = run(spec, os.path.join(self.dir, "nobody.sock"), self.dir, firmware_wait_s=0.5)
        self.assertEqual(r["result"], "not run")

    def test_verdict_and_gripper_mapping(self):
        self.assertEqual(landed([0.16, 0.125, 0.0125], CUP), (True, 0.0))
        ok, d = landed([0.16 + 0.04, 0.125, 0.0125], CUP)
        self.assertFalse(ok)
        self.assertAlmostEqual(d, 40)
        self.assertFalse(landed([0.16, 0.125, 0.07], CUP)[0], "above the rim")
        self.assertAlmostEqual(grip_target(45, GRIP), 0.02)
        self.assertEqual(grip_target(120, GRIP), 0.04)

    def test_missing_numbers_come_from_the_model_module(self):
        full = {"gripper": GRIP, "cup": CUP}
        self.assertIs(with_model_defaults(full), full, "a full spec needs no model module")
        try:
            from mech import arm_model  # noqa: F401
        except ImportError:
            # Before py/mech/arm_model.py exists the bridge says so instead of guessing.
            spec = {"mjcf": self.mjcf, "joints": JOINTS, "gripper": {"closedDeg": 0, "openDeg": 90}, "periodMs": 20, "repeats": 5, "spawn": [0, 0, 0], "cup": {"xMm": 0, "yMm": 0}}
            r = run(spec, os.path.join(self.dir, "nobody.sock"), self.dir, firmware_wait_s=0.5)
            self.assertEqual(r["result"], "not run")
            self.assertIn("arm_model", r["reason"])
            return
        got = with_model_defaults({"gripper": {"closedDeg": 0, "openDeg": 90}, "cup": {"xMm": 1, "yMm": 2}})
        self.assertEqual(got["cup"]["innerRMm"], arm_model.CUP_INNER_MM)
        self.assertEqual(got["gripper"]["openQ"], arm_model.GRIPPER_OPEN_Q)


if __name__ == "__main__":
    unittest.main()
