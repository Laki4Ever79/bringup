"""The simulated rover cruises where the plan's load line says (src/mechanics: the motor's torque meets the rolling
torque, Crr * m * g * r / 2 per wheel). Measured 15 Nov 2026 on the test rover, the reference rover and Rover with a Pi
at duty 0.4 and 0.8: -1.6 % to +0.4 % with no rolling torque added in MuJoCo (its contacts and the caster's own friction
already cost about that much); adding Crr on top made it 3-5 % slow. The backlog's "about 10 % fast" predates the caster
friction fix and the one load-line model. Run: .venv/bin/python -B -m unittest discover -s py/tests -p 'test_mech*.py'"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import mujoco  # noqa: E402
from mech.model import build_model, motor_torque  # noqa: E402
from test_mech_model import SPEC  # noqa: E402

TOLERANCE = 0.03


def plan_speed(spec, volts, duty):
    r = spec["drive"]["wheelDiameterMm"] / 2000
    roll = spec["estimates"]["rollingCrr"] * spec["massG"] / 1000 * 9.81 * r / 2
    lo, hi = 0.0, 1000.0
    for _ in range(80):
        mid = (lo + hi) / 2
        if motor_torque(spec["motor"], volts, duty, mid)[0] > roll:
            lo = mid
        else:
            hi = mid
    return lo * r


def sim_speed(spec, volts, duty, seconds=4.0):
    model = build_model(spec)
    data = mujoco.MjData(model)
    jl, jr = model.joint("left"), model.joint("right")
    r = spec["drive"]["wheelDiameterMm"] / 2000
    for _ in range(int(seconds / model.opt.timestep)):
        w = (data.qvel[jl.dofadr[0]], data.qvel[jr.dofadr[0]])
        data.ctrl[0], data.ctrl[1] = (motor_torque(spec["motor"], volts, duty, x)[0] for x in w)
        mujoco.mj_step(model, data)
    return (data.qvel[jl.dofadr[0]] + data.qvel[jr.dofadr[0]]) / 2 * r


class CruiseSpeed(unittest.TestCase):
    def test_sim_cruises_at_the_plans_speed(self):
        volts = SPEC["pack"]["nominalV"]
        for duty in (0.4, 0.8):
            plan, sim = plan_speed(SPEC, volts, duty), sim_speed(SPEC, volts, duty)
            self.assertLess(abs(sim / plan - 1), TOLERANCE, f"duty {duty}: sim {sim:.3f} m/s, plan {plan:.3f} m/s")


if __name__ == "__main__":
    unittest.main()
