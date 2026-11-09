"""Firmware in the loop: the rover's real firmware (in QEMU) drives the MuJoCo rover over a course.

Usage: drive.py <chassis-spec.json> <port> <out-dir> [course_s]

The firmware's simulation build talks over UART1 (a TCP socket QEMU serves) in lock-step, one line each way per
control tick (templates/fw-rover/SIM.md): "M <tick> <left> <right>" from the firmware; this bridge steps the physics
by one control period with those duties and answers "S <now_ms> <distance_mm|-1> <temp_c> <rh>".

The course: a 2.5 × 2 m room; the rover starts at the origin facing a wall 1.5 m ahead, with a 1 cm step across the
floor from 0.6 m on. It passes when it climbs the step, never touches a wall, turns away from the wall, keeps driving
afterwards, reaches 90 % of its target speed, and no motor draws more than the driver's peak. Results: drive.json and
trajectory.json (10 Hz) in out-dir.
"""

import json
import math
import socket
import sys
import time
from pathlib import Path

import mujoco
import numpy as np

from mech.model import battery_volts, build_model, motor_torque

FRONT_WALL_X = 1.5
BACK_WALL_X = -1.0
SIDE_WALL_Y = 1.0
STEP_X = 0.6
STEP_H = 0.01
PAYLOAD = (22.5, 45.0)  # what the simulated payload sensor reads (fixed, stated in the report)


def course_xml():
    walls = [
        ("wall_front", FRONT_WALL_X + 0.01, 0, 0.01, SIDE_WALL_Y),
        ("wall_back", BACK_WALL_X - 0.01, 0, 0.01, SIDE_WALL_Y),
        ("wall_left", (FRONT_WALL_X + BACK_WALL_X) / 2, SIDE_WALL_Y + 0.01, (FRONT_WALL_X - BACK_WALL_X) / 2, 0.01),
        ("wall_right", (FRONT_WALL_X + BACK_WALL_X) / 2, -SIDE_WALL_Y - 0.01, (FRONT_WALL_X - BACK_WALL_X) / 2, 0.01),
    ]
    xml = "".join(f'<geom name="{n}" type="box" pos="{x} {y} 0.15" size="{sx} {sy} 0.15" rgba=".7 .7 .7 1"/>' for n, x, y, sx, sy in walls)
    step_len = (FRONT_WALL_X - STEP_X) / 2
    xml += f'<geom name="step" type="box" pos="{STEP_X + step_len} 0 {STEP_H / 2}" size="{step_len} {SIDE_WALL_Y} {STEP_H / 2}" rgba=".5 .5 .6 1"/>'
    return xml


def _result(out_dir, result, reason, segments=(), stats=None, trajectory=()):
    r = {"result": result, "reason": reason, "segments": list(segments), **(stats or {})}
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "drive.json").write_text(json.dumps(r, indent=1))
    (out / "trajectory.json").write_text(json.dumps(list(trajectory)))
    return r


def _connect(port, wait_s):
    deadline = time.monotonic() + wait_s
    while True:
        try:
            s = socket.create_connection(("127.0.0.1", port), timeout=wait_s)
            return s
        except OSError:
            if time.monotonic() > deadline:
                return None
            time.sleep(0.1)


def run(spec, port, out_dir, course_s=25.0, firmware_wait_s=10.0, tick_wait_s=10.0):
    model = build_model(spec, course_xml())
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
    chassis = model.body("chassis").id
    tof = model.site("tof").id
    jl, jr = model.joint("left"), model.joint("right")
    walls = {model.geom(n).id for n in ("wall_front", "wall_back", "wall_left", "wall_right")}
    rover_geoms = {g for g in range(model.ngeom) if model.body_rootid[model.geom_bodyid[g]] == chassis}
    period = spec["sensor"]["updateMs"] / 1000
    steps = max(1, round(period / model.opt.timestep))
    rng = spec["sensor"]["rangeMm"] / 1000
    pack, motor = spec["pack"], spec["motor"]
    ohm = spec["estimates"].get("packOhm", 0.15)
    capacity_as = pack["mAh"] * 3.6
    L = spec["plate"]["lengthMm"] / 1000
    W = spec["plate"]["widthMm"] / 1000

    sock = _connect(port, firmware_wait_s)
    if sock is None:
        return _result(out_dir, "not run", f"the firmware didn't answer within {firmware_wait_s:g} s (no connection)")
    sock.settimeout(firmware_wait_s)
    f = sock.makefile("rw", newline="\n")

    soc, used_as, last_total = 1.0, 0.0, 0.0
    peak_a = 0.0
    top_speed = 0.0
    start_z = data.xpos[chassis][2]
    max_x, max_dz = 0.0, 0.0
    wall_contact = None
    closest = math.inf
    yaw0 = None
    turned_at = None
    moved_after_turn = 0.0
    trajectory = []
    last_sample = -1.0
    ticks = 0
    try:
        while data.time < course_s:
            try:
                line = f.readline()
            except (socket.timeout, TimeoutError, OSError):
                line = ""
            if not line:
                if ticks == 0:
                    return _result(out_dir, "not run", f"the firmware didn't answer within {firmware_wait_s:g} s")
                return _result(out_dir, "fail", f"the firmware stopped answering at {data.time:.2f} s")
            parts = line.split()
            if len(parts) < 4 or parts[0] != "M":
                continue
            if ticks == 0:
                sock.settimeout(tick_wait_s)
            ticks += 1
            duty = (float(parts[2]), float(parts[3]))
            for _ in range(steps):
                omega = (data.qvel[jl.dofadr[0]], data.qvel[jr.dofadr[0]])
                # The cell sags by the current of the step before (1 ms earlier).
                volts = battery_volts(pack, soc, last_total, ohm)
                tl, il = motor_torque(motor, volts, duty[0], omega[0])
                tr, ir = motor_torque(motor, volts, duty[1], omega[1])
                last_total = il + ir
                data.ctrl[0], data.ctrl[1] = tl, tr
                peak_a = max(peak_a, il, ir)
                used_as += (il + ir) * model.opt.timestep
                soc = max(0.0, 1 - used_as / capacity_as)
                mujoco.mj_step(model, data)
                for c in data.contact[: data.ncon]:
                    pair = {c.geom1, c.geom2}
                    if pair & walls and pair & rover_geoms and wall_contact is None:
                        wall_contact = (data.time, model.geom([g for g in pair if g in walls][0]).name)
            pos = data.xpos[chassis]
            rot = data.xmat[chassis].reshape(3, 3)
            heading = rot[:, 0]
            yaw = math.atan2(heading[1], heading[0])
            if yaw0 is None:
                yaw0 = yaw
            vel = data.qvel[0:3]
            speed = float(np.dot(vel[:2], heading[:2]))
            top_speed = max(top_speed, speed)
            max_x = max(max_x, float(pos[0]))
            max_dz = max(max_dz, float(pos[2] - start_z))
            # The plate's corners against the room's walls: how close the rover came.
            for sx in (-1, 1):
                for sy in (-1, 1):
                    cx = pos[0] + rot[0, 0] * sx * L / 2 + rot[0, 1] * sy * W / 2
                    cy = pos[1] + rot[1, 0] * sx * L / 2 + rot[1, 1] * sy * W / 2
                    closest = min(closest, FRONT_WALL_X - cx, cx - BACK_WALL_X, SIDE_WALL_Y - cy, cy + SIDE_WALL_Y)
            turn = abs(math.atan2(math.sin(yaw - yaw0), math.cos(yaw - yaw0)))
            if turned_at is None and turn > math.radians(45):
                turned_at = (pos[0], pos[1])
            elif turned_at is not None:
                moved_after_turn = max(moved_after_turn, math.hypot(pos[0] - turned_at[0], pos[1] - turned_at[1]))
            if data.time - last_sample >= 0.1:
                last_sample = data.time
                trajectory.append([round(data.time, 3), round(float(pos[0]), 4), round(float(pos[1]), 4), round(yaw, 4)])
            # The distance sensor: a ray along the rover's heading from its mount, up to its range.
            origin = data.site_xpos[tof].copy()
            direction = np.array([heading[0], heading[1], 0.0])
            direction /= np.linalg.norm(direction) or 1
            geomid = np.array([-1], dtype=np.int32)
            dist = mujoco.mj_ray(model, data, origin, direction, None, 1, chassis, geomid)
            reading = int(round(dist * 1000)) if 0 <= dist <= rng else -1
            f.write(f"S {int(round(data.time * 1000))} {reading} {PAYLOAD[0]} {PAYLOAD[1]}\n")
            f.flush()
            if wall_contact:
                break
    finally:
        try:
            sock.close()
        except OSError:
            pass

    target = spec.get("speedMps", 0.3)
    segments = [
        {"name": "edge crossed", "pass": bool(max_x > STEP_X + 0.1 and max_dz > STEP_H * 0.7), "detail": f"reached x = {max_x:.2f} m, {max_dz * 1000:.1f} mm up (the step is {STEP_H * 1000:.0f} mm at {STEP_X} m)"},
        {"name": "no wall contact", "pass": wall_contact is None, "detail": f"touched {wall_contact[1]} at {wall_contact[0]:.2f} s" if wall_contact else f"closest {closest * 1000:.0f} mm"},
        {"name": "turned away", "pass": turned_at is not None, "detail": "turned more than 45° from its start" if turned_at else "never turned away"},
        {"name": "kept driving", "pass": bool(moved_after_turn >= 0.3), "detail": f"{moved_after_turn:.2f} m after turning (nothing ahead in range: the reading is -1, not 0 mm)"},
        {"name": "top speed", "pass": bool(top_speed >= 0.9 * target), "detail": f"{top_speed:.2f} m/s (target {target} m/s, 90 % needed)"},
        {"name": "peak current", "pass": bool(peak_a <= spec.get("driverPeakA", math.inf)), "detail": f"{peak_a:.2f} A per motor (driver peak {spec.get('driverPeakA', '?')} A)"},
    ]
    failed = [s for s in segments if not s["pass"]]
    reason = "; ".join(f"{s['name']}: {s['detail']}" for s in failed) if failed else "every segment passed"
    if wall_contact:
        reason = f"hit the wall ({wall_contact[1]}) at {wall_contact[0]:.2f} s; " + reason
    stats = {"peakA": round(peak_a, 3), "topSpeedMps": round(top_speed, 3), "closestWallMm": round(closest * 1000), "simSeconds": round(data.time, 2), "ticks": ticks, "payload": {"tempC": PAYLOAD[0], "rh": PAYLOAD[1]}}
    return _result(out_dir, "fail" if failed else "pass", reason, segments, stats, trajectory)


def main():
    if len(sys.argv) < 4:
        print("usage: drive.py <chassis-spec.json> <port> <out-dir> [course_s]", file=sys.stderr)
        sys.exit(2)
    spec = json.loads(Path(sys.argv[1]).read_text())
    r = run(spec, int(sys.argv[2]), sys.argv[3], float(sys.argv[4]) if len(sys.argv) > 4 else 25.0)
    print(json.dumps({"result": r["result"], "reason": r["reason"]}))


if __name__ == "__main__":
    main()
