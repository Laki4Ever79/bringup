"""The rover's physics for MuJoCo, from the chassis spec (src/tools/chassis.ts ChassisSpec).

The same linear DC motor model as src/mechanics/model.ts motorAt (output shaft: R = ratedV / stallA, kt = stall
torque / stall current, ke = ratedV / no-load speed), the cell's voltage sagging under load, and the rover as one
chassis body (the design's mass and centre of mass, minus the wheels and caster) on two driven wheels and a caster.
World frame: x forward at the start, z up, metres. The chassis body's origin sits on the axle line, at the wheel
centres' height.
"""

import math

import mujoco

WHEEL_MASS_KG = 0.0113  # Pololu 60 × 8 mm wheel (catalog/mechanics.json)
CASTER_MASS_KG = 0.033  # the 25 mm swivel caster (catalog/mechanics.json)


def motor_torque(motor, volts, duty, omega):
    """Output-shaft torque (N·m) and current (A) at supply `volts`, PWM `duty` (−1…1) and shaft speed `omega` (rad/s)."""
    r = motor["ratedV"] / motor["stallA"]
    kt = motor["stallTorqueNm"] / motor["stallA"]
    ke = motor["ratedV"] / (motor["noLoadRpm"] * 2 * math.pi / 60)
    current = (volts * duty - ke * omega) / r
    return kt * current, abs(current)


def battery_volts(pack, soc, current_a, internal_ohm):
    """Terminal voltage: open-circuit voltage linear from cut-off (empty) to full (an estimate), minus I·R."""
    ocv = pack["cutoffV"] + (pack["fullV"] - pack["cutoffV"]) * max(0.0, min(1.0, soc))
    return ocv - current_a * internal_ohm


def build_model(spec, course_xml=""):
    """The MjModel of the rover (and an optional course: extra worldbody XML) from a chassis spec."""
    d = spec["drive"]
    p = spec["plate"]
    mm = 0.001
    r = d["wheelDiameterMm"] / 2 * mm
    ww = d["wheelWidthMm"] * mm
    track = d["trackMm"] * mm
    axle_x = d["axleXMm"] * mm
    caster_x = (d["axleXMm"] - d["wheelbaseMm"]) * mm
    caster_r = spec["caster"]["wheelMm"] / 2 * mm
    total = spec["massG"] / 1000
    body_mass = max(0.01, total - 2 * WHEEL_MASS_KG - CASTER_MASS_KG)
    com = [c * mm for c in spec["com"]]
    mu = spec["estimates"]["floorMu"]
    L, W, t = p["lengthMm"] * mm, p["widthMm"] * mm, p["thicknessMm"] * mm
    plate_z = p["clearanceMm"] * mm + t / 2 - r  # relative to the axle line
    # Inertia: the body mass spread over the plate's box (an estimate; the solver only needs it plausible).
    ixx = body_mass * (W * W + 0.03 ** 2) / 12
    iyy = body_mass * (L * L + 0.03 ** 2) / 12
    izz = body_mass * (L * L + W * W) / 12
    s = spec["sensor"]
    # The chassis body's frame: x from the plate's centre (as the spec), z from the axle line.
    tof = [s["xMm"] * mm, s["yMm"] * mm, s["zMm"] * mm - r]
    xml = f"""
<mujoco model="rover">
  <option timestep="0.001" gravity="0 0 -9.81" integrator="implicitfast"/>
  <default><geom condim="3" friction="{mu} 0.005 0.0001"/></default>
  <worldbody>
    <geom name="floor" type="plane" size="10 10 0.1"/>
    {course_xml}
    <body name="chassis" pos="0 0 {r + 0.002}">
      <freejoint name="root"/>
      <inertial pos="{com[0]} {com[1]} {com[2] - r}" mass="{body_mass}" diaginertia="{ixx} {iyy} {izz}"/>
      <geom name="plate" type="box" pos="0 0 {plate_z}" size="{L / 2} {W / 2} {t / 2}" mass="0" contype="1" conaffinity="1"/>
      <site name="tof" pos="{tof[0]} {tof[1]} {tof[2]}" size="0.003"/>
      <body name="wheel_left" pos="{axle_x} {track / 2} 0">
        <joint name="left" type="hinge" axis="0 1 0" damping="0.0001"/>
        <geom type="cylinder" size="{r} {ww / 2}" euler="90 0 0" mass="{WHEEL_MASS_KG}"/>
      </body>
      <body name="wheel_right" pos="{axle_x} {-track / 2} 0">
        <joint name="right" type="hinge" axis="0 1 0" damping="0.0001"/>
        <geom type="cylinder" size="{r} {ww / 2}" euler="90 0 0" mass="{WHEEL_MASS_KG}"/>
      </body>
      <body name="caster" pos="{caster_x} 0 {caster_r - r}">
        <geom type="sphere" size="{caster_r}" mass="{CASTER_MASS_KG}" friction="0.02 0.001 0.0001"/>
      </body>
    </body>
  </worldbody>
  <actuator>
    <motor name="m_left" joint="left" gear="1" ctrllimited="false"/>
    <motor name="m_right" joint="right" gear="1" ctrllimited="false"/>
  </actuator>
</mujoco>"""
    return mujoco.MjModel.from_xml_string(xml)
