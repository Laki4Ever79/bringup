"""The arm's MuJoCo model (py/mech/arm_model.py). Run: .venv/bin/python -B -m unittest py/tests/test_arm_model.py"""

import math
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import mujoco  # noqa: E402

from mech.arm_model import CUP_INNER_MM, CUP_RIM_MM, GRIPPER_CLOSED_Q, GRIPPER_OPEN_Q, JOINTS, arm_xml, build_arm_model  # noqa: E402
sys.path.insert(0, os.path.dirname(__file__))
from arm_fixture import ARM, TARGETS  # noqa: E402

VALUES = {"arm": ARM, "armTargets": TARGETS}


def solve(arm, at):
    """src/arm/kinematics.ts solve with the gripper pointing down (degrees), for the scripted pick below."""
    j = {x["name"]: x for x in arm["joints"]}
    l1, l2, l3 = j["shoulder"]["linkMm"], j["elbow"]["linkMm"], j["wrist-pitch"]["linkMm"] + j["wrist-roll"]["linkMm"]
    yaw = math.degrees(math.atan2(at[1], at[0]))
    r = math.hypot(at[0], at[1]) - j["base-yaw"]["linkMm"]
    z = at[2] - arm["base"]["shoulderZMm"] + l3
    d = math.hypot(r, z)
    c2 = max(-1, min(1, (d * d - l1 * l1 - l2 * l2) / (2 * l1 * l2)))
    for sign in (-1, 1):
        el = sign * math.acos(c2)
        sh = math.atan2(z, r) - math.atan2(l2 * math.sin(el), l1 + l2 * math.cos(el))
        pose = [yaw, math.degrees(sh), math.degrees(el), -90 - math.degrees(sh) - math.degrees(el), 0]
        if all(j[n]["minDeg"] - 1e-6 <= p <= j[n]["maxDeg"] + 1e-6 for n, p in zip(JOINTS, pose)):
            return pose
    raise AssertionError(f"no pose for {at}")


class ArmModelTest(unittest.TestCase):
    def setUp(self):
        self.m = build_arm_model(VALUES)
        self.d = mujoco.MjData(self.m)

    def drive(self, pose_deg, grip, seconds):
        # As the firmware does: the joint targets ramp from where they were to the new pose over the first half of the
        # stage, then hold; the gripper's target jumps.
        start = [float(self.d.actuator(n).ctrl[0]) for n in JOINTS]
        steps = int(seconds / self.m.opt.timestep)
        self.d.actuator("gripper").ctrl = grip
        for i in range(steps):
            f = min(1.0, i / (steps / 2))
            for k, n in enumerate(JOINTS):
                self.d.actuator(n).ctrl = start[k] + (math.radians(pose_deg[k]) - start[k]) * f
            mujoco.mj_step(self.m, self.d)

    def test_names_the_bridge_expects(self):
        names = [self.m.actuator(i).name for i in range(self.m.nu)]
        self.assertEqual(names, JOINTS + ["gripper"])
        self.assertEqual(self.m.joint("cube").type, mujoco.mjtJoint.mjJNT_FREE)
        self.assertEqual((CUP_INNER_MM, CUP_RIM_MM), (35, 50))
        self.assertGreater(GRIPPER_OPEN_Q, GRIPPER_CLOSED_Q)
        # The cube starts at the pick point, on the table; the cup is centred at the drop point.
        self.assertTrue(all(abs(a - b) < 1e-9 for a, b in zip(self.m.body("cube").pos, (0.18, -0.125, 0.0125))))
        self.assertTrue(all(abs(a - b) < 1e-9 for a, b in zip(self.m.site("cup").pos, (0.16, 0.125, 0))))

    def test_grip_site_matches_the_kinematics(self):
        for pose, tip in (([0, 0, 0, 0, 0], (280, 0, 60)), ([0, 90, 0, 0, 0], (0, 0, 60 + 280)), (solve(ARM, (180, -125, 20)), (180, -125, 20))):
            self.d.qpos[: len(JOINTS)] = [math.radians(p) for p in pose]
            mujoco.mj_forward(self.m, self.d)
            got = self.d.site("grip").xpos * 1000
            self.assertLess(max(abs(a - b) for a, b in zip(got, tip)), 0.01, (pose, got, tip))

    def test_force_range_is_stall_at_the_rail(self):
        # MG996R at 6 V: 1.0787 N·m; SG90: 0.2354 N·m.
        self.assertAlmostEqual(self.m.actuator("shoulder").forcerange[1], 1.0787, places=4)
        self.assertAlmostEqual(self.m.actuator("wrist-pitch").forcerange[1], 0.2354, places=4)

    def test_holds_itself_stretched_out(self):
        self.drive([0, 0, 0, 0, 0], GRIPPER_OPEN_Q, 1.5)
        tip = self.d.site("grip").xpos * 1000
        self.assertLess(abs(tip[2] - 60), 10, tip)

    def test_wrist_settles_without_ringing(self):
        # lead-3's acceptance trace (26 Nov): an SG90 wrist rang ±13° at 2 Hz after each move. A servo settles.
        self.drive([0, 30, -30, -68.1, 0], GRIPPER_OPEN_Q, 1.7)
        seen = []
        for _ in range(10):
            for _ in range(int(0.1 / self.m.opt.timestep)):
                mujoco.mj_step(self.m, self.d)
            seen.append(math.degrees(self.d.joint("wrist-pitch").qpos[0]))
        self.assertLess(max(abs(x + 68.1) for x in seen), 2.0, seen)
        # And a fresh step: no more than 3° past the target.
        start = math.degrees(self.d.joint("wrist-pitch").qpos[0])
        self.d.actuator("wrist-pitch").ctrl = math.radians(-20)
        lo = start
        for _ in range(int(1.0 / self.m.opt.timestep)):
            mujoco.mj_step(self.m, self.d)
            lo = max(lo, math.degrees(self.d.joint("wrist-pitch").qpos[0]))
        self.assertLess(lo, -20 + 3, lo)

    def test_scripted_pick_and_place_lands_in_the_cup(self):
        pick, drop = (180, -125, 20), (160, 125, 60)
        above = lambda p: (p[0], p[1], p[2] + 40)  # noqa: E731
        for pose, grip, s in [
            (solve(ARM, above(pick)), GRIPPER_OPEN_Q, 1.5),
            (solve(ARM, pick), GRIPPER_OPEN_Q, 1.0),
            (solve(ARM, pick), GRIPPER_CLOSED_Q, 0.8),
            (solve(ARM, above(pick)), GRIPPER_CLOSED_Q, 1.0),
            (solve(ARM, above(drop)), GRIPPER_CLOSED_Q, 2.0),
            (solve(ARM, drop), GRIPPER_CLOSED_Q, 0.8),
            (solve(ARM, drop), GRIPPER_OPEN_Q, 1.0),
        ]:
            self.drive(pose, grip, s)
        c = self.d.body("cube").xpos * 1000
        self.assertLess(math.hypot(c[0] - drop[0], c[1] - drop[1]), CUP_INNER_MM, c)
        self.assertLess(c[2], CUP_RIM_MM, c)

    def test_cli_writes_a_model_that_loads(self):
        import json

        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "contract.json")
            with open(src, "w") as f:
                json.dump({"values": VALUES}, f)
            out = os.path.join(tmp, "out", "arm.xml")
            py = os.path.join(os.path.dirname(__file__), "..")
            subprocess.run([sys.executable, os.path.join(py, "mech", "arm_model.py"), src, out], cwd=py, env={**os.environ, "PYTHONPATH": py}, check=True)
            self.assertEqual(mujoco.MjModel.from_xml_path(out).nu, 6)
            with open(out) as f:
                self.assertEqual(f.read(), arm_xml(VALUES))


if __name__ == "__main__":
    unittest.main()
