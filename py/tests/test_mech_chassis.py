"""The rover chassis generator (py/chassis.py). Run: .venv/bin/python -B -m unittest discover -s py/tests -p 'test_mech*.py'"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from chassis import ChassisError, build  # noqa: E402

SPEC = {
    "plate": {"lengthMm": 150, "widthMm": 110, "thicknessMm": 3, "clearanceMm": 35},
    "standoffMm": 10,
    "motors": [{"side": "left", "xMm": 30, "yMm": 48, "bodyMm": [26, 12, 10]}, {"side": "right", "xMm": 30, "yMm": -48, "bodyMm": [26, 12, 10]}],
    "caster": {"xMm": -60, "holesMm": [[-14, -11.5], [14, -11.5], [-14, 11.5], [14, 11.5]], "holeDiaMm": 4.2},
    "battery": {"xMm": -25, "yMm": 0, "sizeMm": [60, 36, 7]},
    "boards": [{"name": "main", "xMm": 10, "yMm": 0, "widthMm": 60, "heightMm": 40, "rotDeg": 0, "holeInsetMm": 3.5}],
    "sensor": {"xMm": 72, "yMm": 0, "zMm": 50, "sizeMm": [21, 18, 2.8]},
}


class ChassisTest(unittest.TestCase):
    def test_the_standoff_and_caster_holes_sit_where_the_spec_says(self):
        part, mounts = build(SPEC)
        want = sorted([(round(x, 1), round(y, 1)) for x in (10 - 26.5, 10 + 26.5) for y in (-16.5, 16.5)])
        got = sorted((round(h["xMm"], 1), round(h["yMm"], 1)) for h in mounts["standoffHoles"])
        self.assertEqual(len(got), 4)
        for (gx, gy), (wx, wy) in zip(got, want):
            self.assertAlmostEqual(gx, wx, delta=0.1)
            self.assertAlmostEqual(gy, wy, delta=0.1)
        caster = sorted((round(h["xMm"], 1), round(h["yMm"], 1)) for h in mounts["casterHoles"])
        self.assertEqual(caster, sorted([(-74.0, -11.5), (-46.0, -11.5), (-74.0, 11.5), (-46.0, 11.5)]))

    def test_the_part_spans_the_plate(self):
        part, mounts = build(SPEC)
        bb = part.bounding_box()
        self.assertAlmostEqual(bb.max.X - bb.min.X, 150, delta=0.5)
        # The motor cradles reach past the plate's edge to the wheels: 2 × (48 + 26 / 2) mm.
        self.assertAlmostEqual(bb.max.Y - bb.min.Y, 122, delta=0.5)
        self.assertLess(bb.min.Z, 0, "the motor cradles hang under the plate")

    def test_a_plate_smaller_than_a_board_is_refused_with_a_reason(self):
        small = dict(SPEC, plate=dict(SPEC["plate"], lengthMm=50, widthMm=30))
        with self.assertRaises(ChassisError) as e:
            build(small)
        self.assertIn("main", str(e.exception))


if __name__ == "__main__":
    unittest.main()
