"""The MuJoCo rover model (py/mech/model.py). Run: .venv/bin/python -B -m unittest discover -s py/tests -p 'test_mech*.py'"""

import math
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import mujoco  # noqa: E402

from mech.model import battery_volts, build_model, motor_torque  # noqa: E402

MOTOR = {"ratedV": 6, "noLoadRpm": 220, "stallTorqueNm": 0.0922, "stallA": 0.67, "noLoadA": 0.07}
SPEC = {
    "plate": {"lengthMm": 150, "widthMm": 110, "thicknessMm": 3, "clearanceMm": 35},
    "caster": {"xMm": -60, "wheelMm": 25, "heightMm": 35},
    "sensor": {"xMm": 72, "yMm": 0, "zMm": 50, "sizeMm": [21, 18, 2.8], "rangeMm": 1200, "updateMs": 33},
    "massG": 230.0,
    "com": [5.0, 0.0, 40.0],
    "drive": {"trackMm": 130, "axleXMm": 30, "wheelbaseMm": 90, "wheelDiameterMm": 60, "wheelWidthMm": 8},
    "motor": MOTOR,
    "pack": {"nominalV": 3.7, "fullV": 4.2, "cutoffV": 3.0, "mAh": 2000, "internalOhm": None},
    "estimates": {"floorMu": 0.6, "rollingCrr": 0.02, "packOhm": 0.15},
}


class MotorTest(unittest.TestCase):
    def test_stalled_at_full_duty_it_gives_the_datasheet_stall_torque_and_current(self):
        t, i = motor_torque(MOTOR, 6, 1.0, 0.0)
        self.assertAlmostEqual(t, 0.0922, places=6)
        self.assertAlmostEqual(i, 0.67, places=6)

    def test_at_no_load_speed_it_gives_no_torque(self):
        t, _ = motor_torque(MOTOR, 6, 1.0, 220 * 2 * math.pi / 60)
        self.assertAlmostEqual(t, 0.0, places=6)

    def test_reverse_duty_reverses_the_torque(self):
        t, _ = motor_torque(MOTOR, 6, -1.0, 0.0)
        self.assertAlmostEqual(t, -0.0922, places=6)

    def test_the_cell_sags_under_load(self):
        self.assertAlmostEqual(battery_volts(SPEC["pack"], 1.0, 0.0, 0.15), 4.2)
        self.assertAlmostEqual(battery_volts(SPEC["pack"], 0.0, 0.0, 0.15), 3.0)
        self.assertAlmostEqual(battery_volts(SPEC["pack"], 1.0, 2.0, 0.15), 3.9)


class ModelTest(unittest.TestCase):
    def test_the_model_weighs_what_the_design_does(self):
        m = build_model(SPEC)
        self.assertAlmostEqual(sum(m.body_mass), 0.230, delta=0.001)

    def test_the_wheels_and_caster_weigh_what_the_spec_says(self):
        # Final review: the model hardcoded the old 60 mm wheel and 25 mm caster; the spec carries the real masses.
        m = build_model({**SPEC, "wheelMassG": 20.0, "casterMassG": 71.0})
        self.assertAlmostEqual(m.body("wheel_left").mass[0], 0.020, places=6)
        self.assertAlmostEqual(m.body("caster").mass[0], 0.071, places=6)
        self.assertAlmostEqual(sum(m.body_mass), 0.230, delta=0.001)

    def test_the_whole_rover_balances_at_the_spec_centre_of_mass(self):
        m = build_model({**SPEC, "wheelMassG": 20.0, "casterMassG": 71.0})
        d = mujoco.MjData(m)
        mujoco.mj_forward(m, d)
        root = m.body("chassis").id
        x = sum(m.body_mass[i] * d.xipos[i][0] for i in range(m.nbody) if i == root or m.body_rootid[i] == root) / sum(m.body_mass[i] for i in range(m.nbody) if i == root or m.body_rootid[i] == root)
        self.assertAlmostEqual(x, SPEC["com"][0] / 1000, delta=0.0005)

    def test_dropped_on_the_floor_it_settles_upright_and_still(self):
        m = build_model(SPEC)
        d = mujoco.MjData(m)
        for _ in range(int(1.0 / m.opt.timestep)):
            mujoco.mj_step(m, d)
        body = m.body("chassis").id
        up = d.xmat[body].reshape(3, 3)[:, 2]
        self.assertGreater(up[2], 0.98, "upright")
        self.assertLess(abs(d.qvel[0]) + abs(d.qvel[1]), 0.01, "still")


if __name__ == "__main__":
    unittest.main()
