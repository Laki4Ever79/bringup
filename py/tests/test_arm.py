"""The arm's printed parts and checks (py/arm.py). Run: .venv/bin/python -B -m unittest py/tests/test_arm.py"""

import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from arm import ArmError, build, interference, links, poses_of, sweep_poses  # noqa: E402

sys.path.insert(0, os.path.dirname(__file__))
from arm_fixture import ARM  # noqa: E402

BODIES = build(ARM)


class ArmTest(unittest.TestCase):
    def test_links_mass_positive_and_com_inside_bbox(self):
        ls = links(BODIES)
        self.assertEqual([x["name"] for x in ls], ["base-yaw", "shoulder", "elbow", "wrist-pitch", "gripper"])
        for x, (_, _, printed) in zip(ls, BODIES[1:]):
            self.assertGreater(x["massG"], 0, x)
            bb = printed[0][1].bounding_box()
            for c, lo, hi in zip(x["comMm"], tuple(bb.min), tuple(bb.max)):
                self.assertTrue(lo - 0.1 <= c <= hi + 0.1, (x, tuple(bb.min), tuple(bb.max)))

    def test_poses_put_the_grip_frame_where_the_kinematics_do(self):
        # Stretched forward and level: the wrist roll frame sits at x = L1 + L2 + wrist-pitch link, z = shoulderZ.
        t = poses_of(ARM, (0, 0, 0, 0, 0))[-1].position
        self.assertAlmostEqual(t.X, 120 + 110 + 20, places=6)
        self.assertAlmostEqual(t.Z, 60, places=6)
        # Shoulder up 90: the upper arm points straight up.
        t = poses_of(ARM, (0, 90, 0, 0, 0))[3].position
        self.assertAlmostEqual(t.X, 0, places=6)
        self.assertAlmostEqual(t.Z, 60 + 120, places=6)

    def test_sweep_flags_elbow_hitting_base_at_minus_120(self):
        # Before 26 Nov the fixture's elbow went to -120: folded back level, the forearm runs into the base and yaw servo.
        wide = copy.deepcopy(ARM)
        wide["joints"][2]["minDeg"] = -120
        pairs, clashes = interference(wide, build(wide), [(0, 0, -120, 0, 0)])
        self.assertGreater(pairs, 0)
        self.assertTrue(any("forearm" in (c["a"] + c["b"]) or "elbow" in (c["a"] + c["b"]) for c in clashes), clashes)

    def test_default_arm_sweep_clean(self):
        poses = sweep_poses(ARM)
        self.assertGreater(len(poses), 100)
        _, clashes = interference(ARM, BODIES, poses)
        self.assertEqual(clashes, [])

    def test_unknown_servo_is_an_arm_error(self):
        bad = copy.deepcopy(ARM)
        bad["joints"][1]["servo"] = "XYZ123"
        with self.assertRaises(ArmError):
            build(bad)


if __name__ == "__main__":
    unittest.main()
