"""The standard-parts library (py/parts/, ported from cadsmith, MIT License: py/parts/LICENSE): real standard dimensions
with named frames, for the robot's servos, bearings, fasteners and gears. Run:
.venv/bin/python -B -m unittest discover -s py/tests -p 'test_mech*.py'"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import parts  # noqa: E402
from build123d import Pos  # noqa: E402


class PartsTest(unittest.TestCase):
    def test_a_servo_has_its_frames_and_mates_its_horn_where_asked(self):
        s = parts.sg90()
        self.assertEqual(sorted(s.frames), ["hole_1", "hole_2", "horn", "shaft"])
        self.assertAlmostEqual(s.frames["horn"].position.Z, 14.0, delta=0.01)  # the SG90's spline tip (cadsmith's spec)
        moved = s.mate("horn", Pos(10, 0, 0))
        self.assertEqual([round(v, 2) for v in moved.frames["horn"].position], [10.0, 0.0, 0.0])

    def test_bearings_fasteners_and_gears_have_their_standard_sizes(self):
        b = parts.bearing("608")
        bb = b.shape.bounding_box()
        self.assertEqual([round(bb.size.X), round(bb.size.Z)], [22, 7])
        self.assertIn("ISO 4762 M3x10", parts.socket_head_screw("M3", 10).bom)
        g = parts.gear_pair(1, 12, 24, 5)
        self.assertEqual((g.ratio, g.center_distance), (-0.5, 18.0))
        self.assertAlmostEqual((g.g1.shape & g.g2.shape).volume, 0.0, delta=1e-6)  # meshed at home without overlap

    def test_the_licence_travels_with_the_code(self):
        here = os.path.join(os.path.dirname(__file__), "..", "parts")
        self.assertIn("Copyright (c) 2026 Jonathan Fermin", open(os.path.join(here, "LICENSE")).read())
        for f in os.listdir(here):
            if f.endswith(".py"):
                self.assertIn("MIT License: see py/parts/LICENSE", open(os.path.join(here, f)).readline(), f)


if __name__ == "__main__":
    unittest.main()
