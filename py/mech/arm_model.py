"""The arm's physics for MuJoCo (arm task 4), from the contract's `arm` and `armTargets` (src/arm/types.ts).

Frames and angles are src/arm/kinematics.ts's: origin at the base plate's top centre, +x forward, +y left, z up; each
joint's angle is relative to the link before it, 0 = stretched forward and level, positive raises the link. The model is
in metres and radians; the contract is in mm and degrees. The table is the plane z = 0 (the plate top): the cube and the
cup stand on it.

Bodies: the turntable (base yaw, axis z), the upper arm (shoulder), the forearm (elbow), the wrist (wrist pitch; the
three pitch axes along -y, so a positive angle raises the link), the gripper (wrist roll, axis along the link) with two
fingers on slides. The grip point (site "grip") is at the end of the wrist-roll link, midway along the fingers.

Actuators: a position actuator per joint, named as the contract's joints (ctrl in rad, the contract's sign, range = the
joint's limits), its force range ± the servo's stall torque at railV (the bench can't do better), and one "gripper"
actuator on the left finger's slide (ctrl = half the opening in m; the right finger mirrors it). Each joint's damping
is its servo's back-EMF, stall torque / no-load speed at railV (catalog secPer60), so it slews at the servo's rated speed
and no faster; the fingers likewise at the gripper servo's speed on its horn. Armature 0.01. The servos' stiffness (full
stall at SERVO_STALL_ERR_DEG of error) and the gripper's horn radius are ESTIMATES.

usage: arm_model.py <contract.json> <out.xml>     (run from py/ with PYTHONPATH=py)
"""

import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
JOINTS = ["base-yaw", "shoulder", "elbow", "wrist-pitch", "wrist-roll"]

# The bridge's (src/ros/acceptance.ts, py/mech) gripper targets: half the finger opening, in metres.
GRIPPER_OPEN_Q = 0.02
GRIPPER_CLOSED_Q = 0.0
# The drop cup, on the table at the drop point's x/y.
CUP_INNER_MM = 35
CUP_RIM_MM = 50
CUBE_MM = 25
CUBE_G = 50
CUP_WALL_MM = 3
CUP_SEGMENTS = 16

# ESTIMATES (src/mechanics/estimates.ts): a printed link's mass per 100 mm, the gripper's fingers and linkage.
ARM_LINK_G = 25
ARM_GRIPPER_G = 15
SERVO_STALL_ERR_DEG = 2.0  # a hobby servo's P loop: full stall torque at 2° of error (estimate)
# The gripper servo turns a horn that pushes the fingers: force = stall torque / horn radius (estimate).
GRIPPER_HORN_MM = 10
FINGER_T_MM = 4
FINGER_W_MM = 16
ARMATURE = 0.01
FINGER_ARMATURE = 0.005  # kg: keeps the light fingers' slide stable at the 2 ms step


def at_v(points, v, key):
    """src/mechanics/catalog.ts atV: linear between the listed voltages, the nearest beyond them."""
    s = sorted(points, key=lambda p: p["v"])
    if v <= s[0]["v"]:
        return s[0][key]
    for a, b in zip(s, s[1:]):
        if v <= b["v"]:
            return a[key] + (b[key] - a[key]) * (v - a["v"]) / (b["v"] - a["v"])
    return s[-1][key]


def servo_at(servo, volts):
    if not (servo["minV"] - 1e-9 <= volts <= servo["maxV"] + 1e-9):
        raise ValueError(f"{servo['mpn']} is rated {servo['minV']}–{servo['maxV']} V, not {volts} V")
    return {"stallNm": at_v(servo["stallNm"], volts, "nm"), "degPerS": 60 / at_v(servo["secPer60"], volts, "s"), "massG": servo["massG"]}


def load_values(path):
    v = json.loads(Path(path).read_text())
    return v.get("values", v)


def catalog_servos():
    return {s["mpn"]: s for s in json.loads((ROOT / "catalog" / "mechanics.json").read_text())["servos"]}


def _f(*xs):
    return " ".join(f"{x:.6g}" for x in xs)


def build_xml(values, servos=None, kv=None):
    """The MJCF string for the contract's arm, its cube at the pick point and its cup at the drop point."""
    arm = values["arm"]
    t = values.get("armTargets")
    servos = servos or catalog_servos()
    mm = 0.001
    j = {x["name"]: x for x in arm["joints"]}
    sv = {n: servo_at(servos[j[n]["servo"]], arm["railV"]) for n in JOINTS}
    grip = servo_at(servos[arm["gripper"]["servo"]], arm["railV"])
    measured = {x["name"]: x for x in arm.get("links") or []}

    def link_mass(name, length_mm, extra_g=0):
        if name in measured:
            return measured[name]["massG"] / 1000, [c * mm for c in measured[name]["comMm"]]
        return (ARM_LINK_G * length_mm / 100 + extra_g) / 1000, [length_mm / 2 * mm, 0, 0]

    def joint(name, axis):
        lo, hi = math.radians(j[name]["minDeg"]), math.radians(j[name]["maxDeg"])
        damping = sv[name]["stallNm"] / math.radians(sv[name]["degPerS"])
        return f'<joint name="{name}" type="hinge" axis="{axis}" range="{_f(lo, hi)}" limited="true" damping="{damping:.6g}" armature="{ARMATURE}"/>'

    def capsule(length_mm, r_mm=8, rgba="0.92 0.45 0.12 1"):
        L = max(length_mm, 1) * mm
        return f'<geom type="capsule" fromto="0 0 0 {_f(L)} 0 0" size="{_f(r_mm * mm)}" mass="0" rgba="{rgba}" contype="0" conaffinity="0"/>'

    def servo_geom(name, at=(0, 0, 0)):
        # The servo body at its joint: its catalog mass, collision off (the sweep in py/arm.py checks the real solids).
        return f'<geom name="{name}-servo" type="box" pos="{_f(*at)}" size="{_f(0.010, 0.010, 0.010)}" mass="{sv[name]["massG"] / 1000 if name in sv else grip["massG"] / 1000:.6g}" rgba="0.15 0.15 0.18 1" contype="0" conaffinity="0"/>'

    def inertial(mass_com):
        m, c = mass_com
        # A point-like mass at the link's centre of mass: the body's mass is the sum of its geoms' (the servo's box too).
        return f'<geom type="sphere" size="0.006" pos="{_f(*c)}" mass="{max(m, 1e-4):.6g}" contype="0" conaffinity="0" group="3"/>'

    L1, L2 = j["shoulder"]["linkMm"], j["elbow"]["linkMm"]
    Lwp, Lwr = j["wrist-pitch"]["linkMm"], j["wrist-roll"]["linkMm"]
    finger = arm["gripper"]["fingerMm"]
    open_half = min(arm["gripper"]["openMm"] / 2 * mm, 0.05)
    plate = arm["base"]["plateMm"]
    th = arm["base"]["thicknessMm"]

    # The gripper: the roll axis along +x of the wrist-roll frame; the palm FINGER/2 short of the grip point, the
    # fingers reaching FINGER/2 past it, sliding in y.
    palm_x = (Lwr - finger / 2) * mm
    fx = (Lwr) * mm
    grip_force = grip["stallNm"] / (GRIPPER_HORN_MM * mm)
    finger_damping = grip_force / (math.radians(grip["degPerS"]) * GRIPPER_HORN_MM * mm)
    fingers = []
    for side, s in (("left", 1), ("right", -1)):
        jn = "gripper" if side == "left" else "gripper-mirror"
        fingers.append(
            f'<body name="finger-{side}" pos="{_f(fx, 0, 0)}">'
            f'<joint name="{jn}" type="slide" axis="0 {s} 0" range="0 {_f(open_half)}" limited="true" damping="{finger_damping:.6g}" armature="{FINGER_ARMATURE}"/>'
            f'<geom name="pad-{side}" type="box" pos="0 {_f(s * FINGER_T_MM / 2 * mm)} 0" size="{_f(finger / 2 * mm, FINGER_T_MM / 2 * mm, FINGER_W_MM / 2 * mm)}" mass="0.004" friction="1.5 0.02 0.002" condim="4" solref="0.004 1" rgba="0.3 0.3 0.35 1"/>'
            f"</body>"
        )

    wrist_roll = (
        f'<body name="gripper-body" pos="{_f(Lwp * mm, 0, 0)}">{joint("wrist-roll", "1 0 0")}'
        f'{inertial(link_mass("gripper", 0, ARM_GRIPPER_G) if "gripper" in measured else ((ARM_GRIPPER_G + grip["massG"]) / 1000, [palm_x, 0, 0]))}'
        f"{capsule(Lwr - finger / 2, 6)}"
        f'<geom name="palm" type="box" pos="{_f(palm_x, 0, 0)}" size="{_f(0.003, open_half + FINGER_T_MM * mm, FINGER_W_MM / 2 * mm)}" mass="0" rgba="0.3 0.3 0.35 1"/>'
        f'<site name="grip" pos="{_f(fx, 0, 0)}" size="0.004" rgba="0 1 0 1"/>'
        + "".join(fingers)
        + "</body>"
    )
    wrist = (
        f'<body name="wrist" pos="{_f(L2 * mm, 0, 0)}">{joint("wrist-pitch", "0 -1 0")}'
        f'{inertial(link_mass("wrist-pitch", Lwp, sv["wrist-roll"]["massG"]))}{capsule(Lwp, 7)}{servo_geom("wrist-pitch")}'
        f"{wrist_roll}</body>"
    )
    forearm = (
        f'<body name="forearm" pos="{_f(L1 * mm, 0, 0)}">{joint("elbow", "0 -1 0")}'
        f'{inertial(link_mass("elbow", L2))}{capsule(L2)}{servo_geom("elbow")}{wrist}</body>'
    )
    upper = (
        f'<body name="upper-arm" pos="{_f(j["base-yaw"]["linkMm"] * mm, 0, arm["base"]["shoulderZMm"] * mm)}">{joint("shoulder", "0 -1 0")}'
        f'{inertial(link_mass("shoulder", L1))}{capsule(L1)}{servo_geom("shoulder")}{forearm}</body>'
    )
    turntable = (
        f'<body name="turntable" pos="0 0 0">{joint("base-yaw", "0 0 1")}'
        f'{inertial(link_mass("base-yaw", 0, 20) if "base-yaw" in measured else (0.02, [0, 0, arm["base"]["shoulderZMm"] / 2 * mm]))}'
        f'<geom type="cylinder" pos="0 0 {_f(arm["base"]["shoulderZMm"] / 2 * mm)}" size="{_f(0.03, arm["base"]["shoulderZMm"] / 2 * mm)}" mass="0" rgba="0.92 0.45 0.12 1" contype="0" conaffinity="0"/>'
        f"{servo_geom('base-yaw', (0, 0, arm['base']['shoulderZMm'] * mm))}{upper}</body>"
    )

    world = [
        '<geom name="table" type="plane" size="1 1 0.01" rgba="0.85 0.85 0.82 1" friction="1 0.01 0.001"/>',
        f'<geom name="base-plate" type="box" pos="0 0 {_f(-th / 2 * mm)}" size="{_f(plate[0] / 2 * mm, plate[1] / 2 * mm, th / 2 * mm)}" rgba="0.92 0.45 0.12 0.4" contype="0" conaffinity="0"/>',
        turntable,
    ]
    if t:
        cx, cy = t["drop"]["xMm"] * mm, t["drop"]["yMm"] * mm
        r = (CUP_INNER_MM + CUP_WALL_MM / 2) * mm
        seg = 2 * math.pi * r / CUP_SEGMENTS / 2 * 1.05
        for k in range(CUP_SEGMENTS):
            a = 2 * math.pi * k / CUP_SEGMENTS
            world.append(
                f'<geom name="cup-{k}" type="box" pos="{_f(cx + r * math.cos(a), cy + r * math.sin(a), CUP_RIM_MM / 2 * mm)}" euler="0 0 {_f(a)}" '
                f'size="{_f(CUP_WALL_MM / 2 * mm, seg, CUP_RIM_MM / 2 * mm)}" rgba="0.2 0.5 0.9 0.6"/>'
            )
        world.append(f'<site name="cup" pos="{_f(cx, cy, 0)}" size="0.004" rgba="0.2 0.5 0.9 1"/>')
        h = CUBE_MM / 2 * mm
        world.append(
            f'<body name="cube" pos="{_f(t["pick"]["xMm"] * mm, t["pick"]["yMm"] * mm, h)}"><freejoint name="cube"/>'
            f'<geom name="cube" type="box" size="{_f(h, h, h)}" mass="{CUBE_G / 1000}" friction="1.5 0.02 0.002" condim="4" solref="0.004 1" rgba="0.95 0.8 0.1 1"/></body>'
        )

    acts = []
    for n in JOINTS:
        stall = sv[n]["stallNm"]
        kp = stall / math.radians(SERVO_STALL_ERR_DEG)
        lo, hi = math.radians(j[n]["minDeg"]), math.radians(j[n]["maxDeg"])
        damp = f' kv="{kv[n]:.6g}"' if kv else ""
        acts.append(f'<position name="{n}" joint="{n}" kp="{kp:.6g}"{damp} ctrlrange="{_f(lo, hi)}" ctrllimited="true" forcerange="{_f(-stall, stall)}" forcelimited="true"/>')
    gf = grip_force
    acts.append(f'<position name="gripper" joint="gripper" kp="{gf / 0.004:.6g}" ctrlrange="{_f(GRIPPER_CLOSED_Q, open_half)}" ctrllimited="true" forcerange="{_f(-gf, gf)}" forcelimited="true"/>')

    return f"""<mujoco model="bringup-arm">
  <compiler angle="radian" autolimits="true"/>
  <option timestep="0.002" integrator="implicitfast" cone="elliptic" impratio="10"/>
  <worldbody>
    <light pos="0 0 1.2" dir="0 0 -1"/>
    {"".join(world)}
  </worldbody>
  <equality><joint joint1="gripper-mirror" joint2="gripper" polycoef="0 1 0 0 0" solref="0.004 1" solimp="0.95 0.99 0.001"/></equality>
  <contact><exclude body1="finger-left" body2="finger-right"/></contact>
  <actuator>{"".join(acts)}</actuator>
</mujoco>
"""


def servo_kv(values, servos=None):
    """The servos' own loop damping, per joint: critical (2·sqrt(kp·M)) at the arm stretched out, M the joint's
    effective inertia in the compiled model (its links, the servos it carries and its armature). Back-EMF damping alone
    left an SG90 wrist ringing ±13° at 2 Hz for a second (lead-3's acceptance trace, 26 Nov); a hobby servo's P(D) loop
    settles without overshoot."""
    import mujoco

    m = mujoco.MjModel.from_xml_string(build_xml(values, servos))
    d = mujoco.MjData(m)
    mujoco.mj_forward(m, d)
    import numpy as np

    M = np.zeros((m.nv, m.nv))
    mujoco.mj_fullM(m, d, M)
    out = {}
    for n in JOINTS:
        dof = m.jnt_dofadr[m.joint(n).id]
        kp = m.actuator(n).gainprm[0]
        out[n] = 2 * math.sqrt(kp * M[dof, dof])
    return out


def arm_xml(values, servos=None):
    """The MJCF with the servos' loop damping (servo_kv)."""
    return build_xml(values, servos, servo_kv(values, servos))


def build_arm_model(values, servos=None):
    import mujoco

    return mujoco.MjModel.from_xml_string(arm_xml(values, servos))


def main():
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    values = load_values(sys.argv[1])
    if not values.get("arm"):
        print("the contract has no arm", file=sys.stderr)
        sys.exit(1)
    xml = arm_xml(values)
    build_arm_model(values)  # it must compile
    out = Path(sys.argv[2])
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(xml)


if __name__ == "__main__":
    main()
