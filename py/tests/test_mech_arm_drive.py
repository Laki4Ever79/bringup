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

from mech.arm_drive import Pca9685, grip_target, joint_deg, landed, run, with_model_defaults  # noqa: E402

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
# The servo map as src/arm/firmware.ts armServos writes it: joints -90..90 on 180° servos, the gripper 0..90 on one.
SERVOS = [{"channel": i, "minDeg": -90, "maxDeg": 90, "rangeDeg": 180, "pulseUs": [500, 2500]} for i in range(5)] + [{"channel": 5, "minDeg": 0, "maxDeg": 90, "rangeDeg": 180, "pulseUs": [500, 2500]}]
PCA = {"addr": 0x40, "hz": 50}


def pca_lines(joint_deg_list):
    """What the firmware's PCA9685 driver writes for these joint angles (servo_pca9685.cpp servo_write, offsets 0)."""
    out = []
    for sv, j in zip(SERVOS, joint_deg_list):
        s = min(sv["rangeDeg"], max(0, j - sv["minDeg"] + (sv["rangeDeg"] - (sv["maxDeg"] - sv["minDeg"])) / 2))
        us = int(sv["pulseUs"][0] + (sv["pulseUs"][1] - sv["pulseUs"][0]) * s / sv["rangeDeg"] + 0.5)
        off = min(4095, (us * 4096 * 50 + 500000) // 1000000)
        out.append(f"I 40 {0x06 + 4 * sv['channel']:02x} 00 00 {off & 0xFF:02x} {off >> 8:02x}")
    return out


# The driver's start: asleep, PRE_SCALE 121 (50 Hz), awake with auto-increment, restart (servo_pca9685.cpp servo_begin).
PCA_INIT = ["I 40 00 10", "I 40 fe 79", "I 40 00 20", "I 40 00 a0"]


def fake_firmware(unix_path, ticks, grip_deg, init=PCA_INIT):
    """QEMU's UART1 stand-in: the driver's start, then `ticks` lock-step ticks writing the servos' PCA9685 registers
    with the gripper at grip_deg ("T" ends each), then "E"."""
    srv = socket.socket(socket.AF_UNIX)
    srv.bind(unix_path)
    srv.listen(1)
    seen = []

    def serve():
        c, _ = srv.accept()
        f = c.makefile("rw", newline="\n")
        for line in init:
            f.write(line + "\n")
        for t in range(ticks):
            for line in pca_lines([10, 20, -30, -80, 0, grip_deg]):
                f.write(line + "\n")
            f.write(f"T {t}\n")
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

    def drive(self, spawn, grip_deg, ticks=200, init=None):
        spec = {"mjcf": self.mjcf, "joints": JOINTS, "gripper": GRIP, "pca": PCA, "servos": SERVOS, "periodMs": 20, "repeats": 5, "spawn": spawn, "cup": CUP}
        sock = os.path.join(self.dir, "u.sock")
        th, seen = fake_firmware(sock, ticks, grip_deg, **({"init": init} if init is not None else {}))
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
        # The trajectory for the pictures (py/arm_pictures.py): the tracked bodies this model has (the cube), sampled
        # every 50 ms of simulated time, each pose x y z and a quaternion.
        with open(os.path.join(self.dir, "trajectory.json")) as f:
            t = json.load(f)
        self.assertEqual(t["bodies"], ["cube"])
        self.assertEqual(len(t["rest"]["cube"]), 7)
        self.assertGreater(len(t["frames"]), 50)
        self.assertAlmostEqual(t["frames"][1][0] - t["frames"][0][0], 0.06, delta=0.011)
        self.assertEqual(t["cubeHalf"], [0.0125] * 3)
        self.assertEqual(t["joints"], JOINTS)
        self.assertEqual(len(t["frames"][0][2]), 5)

    def test_without_a_spawn_new_cubes_go_where_the_model_put_the_first(self):
        # The toy's cube starts over the cup: every replacement does too.
        r, _ = self.drive(None, 90)
        self.assertEqual(r["result"], "pass", r)

    def test_a_cube_only_nudged_along_the_table_is_not_a_drop(self):
        # The cube rests on a 4° low-friction ramp beside the cup and slides ~60 mm into a stop: moved, at rest, the
        # gripper open, but its height changed by only ~4 mm, never picked up: not a drop (before: a "missed" cube).
        ramp = ('    <geom name="ramp" type="box" pos="0.3 0.125 0.01" size="0.1 0.03 0.01" euler="0 -4 0" friction="0.02"/>\n'
                '    <geom name="stop" type="box" pos="0.235 0.125 0.03" size="0.005 0.03 0.03"/>\n'
                '    <body name="cube" pos="0.3 0.125 0.035">')
        with open(self.mjcf, "w") as f:
            # MuJoCo takes the larger friction of the two geoms: the cube's is lowered too.
            f.write(TOY.replace('    <body name="cube" pos="0.16 0.125 0.08">', ramp).replace('mass="0.05"/>', 'mass="0.05" friction="0.02"/>'))
        r, _ = self.drive(None, 90)
        self.assertEqual(r["attempts"], 0, r)
        self.assertEqual(r["drops"], [])

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
        spec = {"mjcf": self.mjcf, "joints": JOINTS, "gripper": GRIP, "pca": PCA, "servos": SERVOS, "periodMs": 20, "repeats": 5, "spawn": [0, 0, 0], "cup": CUP}
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
            spec = {"mjcf": self.mjcf, "joints": JOINTS, "gripper": {"closedDeg": 0, "openDeg": 90}, "pca": PCA, "servos": SERVOS, "periodMs": 20, "repeats": 5, "spawn": [0, 0, 0], "cup": {"xMm": 0, "yMm": 0}}
            r = run(spec, os.path.join(self.dir, "nobody.sock"), self.dir, firmware_wait_s=0.5)
            self.assertEqual(r["result"], "not run")
            self.assertIn("arm_model", r["reason"])
            return
        got = with_model_defaults({"gripper": {"closedDeg": 0, "openDeg": 90}, "cup": {"xMm": 1, "yMm": 2}})
        self.assertEqual(got["cup"]["innerRMm"], arm_model.CUP_INNER_MM)
        self.assertEqual(got["gripper"]["openQ"], arm_model.GRIPPER_OPEN_Q)

    def test_the_driver_left_asleep_moves_nothing(self):
        # Without the wake-up the chip's outputs stay off: the gripper never opens, no cube is dropped (the first cube
        # falls into the cup anyway only with the gripper commanded open).
        r, _ = self.drive([160, 125, 80], 90, init=["I 40 00 10", "I 40 fe 79"])
        self.assertEqual(r["attempts"], 0, r)
        self.assertEqual(r["i2c"]["hz"], 50.03)

    def test_the_chip_model_follows_the_datasheet(self):
        p = Pca9685()
        self.assertIsNone(p.pulse_us(0), "asleep at power-on: no output")
        p.write([0xFE, 121])  # PRE_SCALE while asleep: takes
        self.assertAlmostEqual(p.hz(), 50.03, places=2)
        p.write([0x00, 0x20])  # awake, AI
        p.write([0xFE, 30])  # PRE_SCALE while awake: the chip ignores it
        self.assertEqual(p.ignored_prescale, 1)
        self.assertAlmostEqual(p.hz(), 50.03, places=2)
        p.write([0x06 + 4 * 3, 0, 0, 307 & 0xFF, 307 >> 8])  # LED3, auto-increment across ON_L..OFF_H
        self.assertAlmostEqual(p.pulse_us(3), 307 * 1e6 / (4096 * p.hz()), places=6)
        self.assertAlmostEqual(p.pulse_us(3), 1498.0, delta=0.5)
        p.write([0x00, 0x00])  # AI off: every byte lands on the same register
        p.write([0x06, 1, 2, 3])
        self.assertEqual(p.reg[0x06:0x0A], [3, 0, 0, 0])
        # The pulse back to the joint: the firmware's map inverted (centre of a 120° servo on a 0..120 joint).
        self.assertAlmostEqual(joint_deg(1500, {"minDeg": 0, "maxDeg": 120, "rangeDeg": 120, "pulseUs": [1000, 2000]}), 60)
        self.assertAlmostEqual(joint_deg(1083.33, {"minDeg": -120, "maxDeg": 90, "rangeDeg": 180, "pulseUs": [1000, 2000]}), -90, places=1)


if __name__ == "__main__":
    unittest.main()
