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
    def test_the_estop_deck_spans_the_plate_with_the_buttons_cutout_and_its_collar(self):
        # The Eurobot base's emergency stop (chassis.ts ChassisEstop, 16 Nov 2026): a bridge on two walls at the plate's
        # long edges, a 2 mm panel with the A22E's 22.3 mm cutout at the button's place, and the 7 mm collar on top.
        es = {"xMm": 40, "yMm": 0, "panelTopMm": 125, "panelMm": 2, "holeMm": 22.3, "headMm": 40, "collarMm": 7}
        # Cradled motors (no clamp): this test is about the deck, not the motor mounts.
        base = {**SPEC, "motors": [{**m, "mount": {"kind": "cradle"}} for m in SPEC["motors"]]}
        part, mounts = build({**base, "estop": es})
        hole = mounts["estopHole"]
        self.assertAlmostEqual(hole["xMm"], 40, delta=0.05)
        self.assertAlmostEqual(hole["yMm"], 0, delta=0.05)
        bb = part.bounding_box()
        self.assertAlmostEqual(bb.max.Z, 125 - 35 + 7, delta=0.05)  # the collar's top, in the plate's frame
        plain, m0 = build(base)
        self.assertNotIn("estopHole", m0)
        # The deck's walls stand on the plate: it reaches no further sideways than the chassis without it.
        self.assertAlmostEqual(bb.max.Y, plain.bounding_box().max.Y, delta=0.05)
        self.assertAlmostEqual(bb.min.Y, plain.bounding_box().min.Y, delta=0.05)
        self.assertLess(plain.bounding_box().max.Z, 40)

    def test_the_standoffs_sit_under_the_boards_own_holes_with_a_pilot_for_its_screw(self):
        # The board's holes come with the spec (chassis.ts boardHoles): 3.0 mm in, not the old 3.5, and the pilot for
        # the case's M2 self-tapping screw (1.6 mm), not an M2.5 clearance hole (15 Nov 2026).
        holes = [{"xMm": 10 + sx * 27, "yMm": sy * 17} for sx in (-1, 1) for sy in (-1, 1)]
        spec = {**SPEC, "boards": [{**SPEC["boards"][0], "holes": holes}], "boardScrew": {"boardHoleMm": 2.2, "pilotMm": 1.6}}
        part, mounts = build(spec)
        got = sorted((round(h["xMm"], 2), round(h["yMm"], 2)) for h in mounts["standoffHoles"])
        self.assertEqual(got, sorted((h["xMm"], h["yMm"]) for h in holes))

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

    # Final review: only boards were checked; a battery, caster or sensor off the plate still built.
    def test_a_battery_off_the_plate_is_refused_with_a_reason(self):
        spec = dict(SPEC, battery=dict(SPEC["battery"], xMm=-70))
        with self.assertRaisesRegex(ChassisError, "battery"):
            build(spec)

    def test_a_caster_off_the_plate_is_refused_with_a_reason(self):
        spec = dict(SPEC, caster=dict(SPEC["caster"], xMm=-80))
        with self.assertRaisesRegex(ChassisError, "caster"):
            build(spec)


if __name__ == "__main__":
    unittest.main()
