"""Firmware in the loop: the rover's real firmware (in QEMU) drives the MuJoCo rover over a course.

Usage: drive.py <chassis-spec.json> <port> <out-dir> [course_s]

The firmware's simulation build talks over UART1 (a TCP socket QEMU serves) in lock-step, one line each way per
control tick (templates/fw-rover/SIM.md): "M <tick> <left> <right>" from the firmware; this bridge steps the physics
by one control period with those duties and answers "S <now_ms> <distance_mm|-1> <temp_c> <rh>", and with wheel
encoders (spec motor.encoderCountsPerRev) each wheel's count after it.

The course: a 2.5 × 2 m room; the rover starts at the origin facing a wall 1.5 m ahead, with a step across the floor
from 0.6 m on, as high as the brief's edge (spec edgeMm). It passes when its caster (the last wheel) gets over the step, never touches a wall, turns away from the wall, keeps driving
afterwards, reaches 90 % of its target speed, and no motor draws more than the driver's peak.

With spec "opponent" ({appearS, leaveS, aheadM, radiusM, gapMm}), a round robot appears aheadM in front of the sensor at
appearS and leaves at leaveS (seen by the sensor only: it isn't a body). Three more segments: it stopped at least gapMm
short of it, held there without turning, and drove on after it left.

With spec "target" ({xMm, yMm, tolMm}: the firmware's go-to build, ROVER_GOTO_X_MM), the rover drives to that point,
given from where its axle's middle starts (x ahead, y to its left). The segments are then: no wall contact, the
driver's peak current, reached the point (the axle's middle within tolMm of it, by the physics, not the odometry) and
came to rest there. Results: drive.json and
trajectory.json (10 Hz rows: time s, x m, y m, yaw rad, left duty, right duty, height change mm) in out-dir.
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
PAYLOAD = (22.5, 45.0)  # what the simulated payload sensor reads (fixed, stated in the report)


def course_xml(step_h):
    walls = [
        ("wall_front", FRONT_WALL_X + 0.01, 0, 0.01, SIDE_WALL_Y),
        ("wall_back", BACK_WALL_X - 0.01, 0, 0.01, SIDE_WALL_Y),
        ("wall_left", (FRONT_WALL_X + BACK_WALL_X) / 2, SIDE_WALL_Y + 0.01, (FRONT_WALL_X - BACK_WALL_X) / 2, 0.01),
        ("wall_right", (FRONT_WALL_X + BACK_WALL_X) / 2, -SIDE_WALL_Y - 0.01, (FRONT_WALL_X - BACK_WALL_X) / 2, 0.01),
    ]
    xml = "".join(f'<geom name="{n}" type="box" pos="{x} {y} 0.15" size="{sx} {sy} 0.15" rgba=".7 .7 .7 1"/>' for n, x, y, sx, sy in walls)
    if step_h <= 0:
        return xml  # a brief with no edge: a flat room
    step_len = (FRONT_WALL_X - STEP_X) / 2
    xml += f'<geom name="step" type="box" pos="{STEP_X + step_len} 0 {step_h / 2}" size="{step_len} {SIDE_WALL_Y} {step_h / 2}" rgba=".5 .5 .6 1"/>'
    return xml


def _result(out_dir, result, reason, segments=(), stats=None, trajectory=()):
    r = {"result": result, "reason": reason, "segments": list(segments), **(stats or {})}
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "drive.json").write_text(json.dumps(r, indent=1))
    (out / "trajectory.json").write_text(json.dumps(list(trajectory)))
    return r


def _connect(port, wait_s):
    """port: a TCP port on 127.0.0.1, or the path of the Unix socket QEMU serves (src/tools/drive.ts: a file in the run
    folder, so no other process can take it between choosing and serving, as a free TCP port could be)."""
    deadline = time.monotonic() + wait_s
    while True:
        try:
            if isinstance(port, str):
                s = socket.socket(socket.AF_UNIX)
                s.settimeout(wait_s)
                s.connect(port)
            else:
                s = socket.create_connection(("127.0.0.1", port), timeout=wait_s)
            return s
        except OSError:
            if time.monotonic() > deadline:
                return None
            time.sleep(0.1)


# firmware_wait_s: wall-clock time for the firmware's first answer (its boot). 60 s: the ESP32-S3 in qemu-system-xtensa
# boots slower than the C3, and inside a run the machine is busy with board builds (the Eurobot mock's S3 drive, 20 Nov
# 2026: booted, then no answer within the old 10 s; the same firmware answered on an idle machine). Time inside QEMU is
# virtual and lock-stepped, so a longer wait costs only when the firmware never answers.
# realtime: simulated time kept to wall-clock time (never ahead of it), for a host that drives the robot on its own
# clock (ROS). Unpaced, the lock-step ran ~2.8x faster than real time: a 1.35 s ROS turn became 3.8 simulated seconds and
# ROS's odometry and gyro read 3x the motion it commanded (23 Nov 2026). A machine too slow for real time just lags.
def run(spec, port, out_dir, course_s=25.0, firmware_wait_s=60.0, tick_wait_s=10.0, realtime=False):
    step_h = spec["edgeMm"] / 1000
    model = build_model(spec, course_xml(step_h))
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
    chassis = model.body("chassis").id
    # A skid-steer rover (drive kind "skid4"): its rear wheels are the last to meet the step, and each of its four
    # motors takes its side's duty at its own wheel's speed.
    skid = spec["drive"].get("kind") == "skid4"
    caster = model.body("wheel_left_rear" if skid else "caster").id
    caster_r = spec["drive"]["wheelDiameterMm"] / 2000 if skid else spec["caster"]["wheelMm"] / 2000
    rear = (model.joint("left_rear"), model.joint("right_rear")) if skid else ()
    tof = model.site("tof").id
    jl, jr = model.joint("left"), model.joint("right")
    walls = {model.geom(n).id for n in ("wall_front", "wall_back", "wall_left", "wall_right")}
    rover_geoms = {g for g in range(model.ngeom) if model.body_rootid[model.geom_bodyid[g]] == chassis}
    period = spec["sensor"]["updateMs"] / 1000
    steps = max(1, round(period / model.opt.timestep))
    rng = spec["sensor"]["rangeMm"] / 1000
    pack, motor = spec["pack"], spec["motor"]
    cpr = motor.get("encoderCountsPerRev")
    # The board's gyro (spec imu, an IMU on the board): its heading since the start, the body's yaw unwrapped, with an
    # angle random walk and a residual bias (both ESTIMATES, tools/chassis.ts IMU_SIM). Seeded: a drive is reproducible.
    imu = spec.get("imu")
    gyro_rng = np.random.default_rng(1)
    gyro = {"last": None, "turned": 0.0, "walk": 0.0}
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
    max_x, caster_x = 0.0, -math.inf
    wall_contact = None
    closest = math.inf
    stop_file = Path(out_dir) / "stop"
    nearest_ahead = math.inf  # the front reading while driving forward: the brief's "stops short of the wall"
    yaw0 = None
    turned_at = None
    moved_after_turn = 0.0
    trajectory = []
    last_sample = -1.0
    tgt = spec.get("target")
    axle0 = None  # the axle's middle and heading at the start: the frame the target is given in
    axle_last = None
    rest_speed = math.inf
    opp = spec.get("opponent")
    opp_c = None  # the opponent's centre once it has appeared
    opp_gap = math.inf  # the nearest the sensor came to it
    opp_yaw0 = None
    opp_turn = 0.0  # the most the heading changed while it stood there
    opp_left_at = None  # (x, y, heading) when it left
    opp_after = 0.0  # forward travel in the 3 s after it left
    ticks = 0
    paced_from = None  # (wall, simulated) time of the first tick, with realtime
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
                currents = [il, ir]
                data.ctrl[0], data.ctrl[1] = tl, tr
                if skid:
                    for k, (j, du) in enumerate(zip(rear, duty)):
                        t, i = motor_torque(motor, volts, du, data.qvel[j.dofadr[0]])
                        data.ctrl[2 + k] = t
                        currents.append(i)
                last_total = sum(currents)
                peak_a = max(peak_a, *currents)
                used_as += last_total * model.opt.timestep
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
            caster_x = max(caster_x, float(data.xpos[caster][0]))
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
            if tgt:
                ax = (data.xpos[model.jnt_bodyid[jl.id]] + data.xpos[model.jnt_bodyid[jr.id]]) / 2
                if axle0 is None:
                    axle0 = (float(ax[0]), float(ax[1]), yaw)
                axle_last = (float(ax[0]), float(ax[1]))
                rest_speed = abs(speed)
            if data.time - last_sample >= 0.1:
                last_sample = data.time
                trajectory.append([round(data.time, 3), round(float(pos[0]), 4), round(float(pos[1]), 4), round(yaw, 4), duty[0], duty[1], round(float(pos[2] - start_z) * 1000, 1)])
            # The distance sensor: a ray along the rover's heading from its mount, up to its range.
            origin = data.site_xpos[tof].copy()
            direction = np.array([heading[0], heading[1], 0.0])
            direction /= np.linalg.norm(direction) or 1
            geomid = np.array([-1], dtype=np.int32)
            dist = mujoco.mj_ray(model, data, origin, direction, None, 1, chassis, geomid)
            reading = int(round(dist * 1000)) if 0 <= dist <= rng else -1
            if opp:
                if opp_c is None and data.time >= opp["appearS"]:
                    ahead = opp["aheadM"] + opp["radiusM"]
                    opp_c = (origin[0] + direction[0] * ahead, origin[1] + direction[1] * ahead)
                    opp_yaw0 = yaw
                if opp_c is not None and data.time < opp["leaveS"]:
                    # The ray against the opponent's circle.
                    ox, oy = origin[0] - opp_c[0], origin[1] - opp_c[1]
                    b = ox * direction[0] + oy * direction[1]
                    disc = b * b - (ox * ox + oy * oy - opp["radiusM"] ** 2)
                    edge = math.hypot(ox, oy) - opp["radiusM"]
                    opp_gap = min(opp_gap, edge)
                    if disc >= 0 and -b - math.sqrt(disc) >= 0 and -b - math.sqrt(disc) <= rng:
                        hit = int(round((-b - math.sqrt(disc)) * 1000))
                        reading = hit if reading < 0 else min(reading, hit)
                    opp_turn = max(opp_turn, abs(math.atan2(math.sin(yaw - opp_yaw0), math.cos(yaw - opp_yaw0))))
                elif opp_c is not None:
                    if opp_left_at is None:
                        opp_left_at = (pos[0], pos[1], heading[0], heading[1], data.time)
                    if data.time - opp_left_at[4] <= 3.0:
                        opp_after = max(opp_after, (pos[0] - opp_left_at[0]) * opp_left_at[2] + (pos[1] - opp_left_at[1]) * opp_left_at[3])
            if reading >= 0 and duty[0] > 0 and duty[1] > 0:
                nearest_ahead = min(nearest_ahead, reading)
            # Wheel encoders (an encoder gearmotor): each wheel's angle in counts (channel A's edges, spec
            # encoderCountsPerRev), positive forward (a positive turn about the wheels' +y axis rolls them forward).
            enc = ""
            if cpr:
                enc = f" {int(data.qpos[jl.qposadr[0]] / (2 * math.pi) * cpr)} {int(data.qpos[jr.qposadr[0]] / (2 * math.pi) * cpr)}"
            gyro_txt = ""
            if imu:
                if gyro["last"] is not None:
                    gyro["turned"] += math.atan2(math.sin(yaw - gyro["last"]), math.cos(yaw - gyro["last"]))
                gyro["last"] = yaw
                dt = steps * model.opt.timestep
                gyro["walk"] += math.radians(imu["noiseDegPerSqrtS"]) * math.sqrt(dt) * float(gyro_rng.standard_normal())
                h = gyro["turned"] + gyro["walk"] + math.radians(imu["biasDegPerS"]) * data.time
                gyro_txt = f" H {int(round(h * 1000))}"
            if realtime:
                if paced_from is None:
                    paced_from = (time.monotonic(), data.time)
                ahead = (data.time - paced_from[1]) - (time.monotonic() - paced_from[0])
                if ahead > 0:
                    time.sleep(ahead)
            f.write(f"S {int(round(data.time * 1000))} {reading} {PAYLOAD[0]} {PAYLOAD[1]}{enc}{gyro_txt}\n")
            f.flush()
            if wall_contact:
                break
            # A host's test (ROS) that ends before the course: runDrive drops "stop" in the out-dir (src/tools/drive.ts
            # until); the course ends here and the results are written as usual.
            if ticks % 30 == 0 and stop_file.exists():
                break
    finally:
        try:
            sock.close()
        except OSError:
            pass

    target = spec.get("speedMps", 0.3)
    segments = [
        # The caster is the last wheel to meet the step: past it means the whole rover climbed (nothing passes through).
        {"name": "edge crossed", "pass": bool(caster_x > STEP_X + caster_r), "detail": f"the caster reached x = {caster_x:.2f} m (the step is {step_h * 1000:g} mm at {STEP_X} m)"},
        {"name": "no wall contact", "pass": wall_contact is None, "detail": f"touched {wall_contact[1]} at {wall_contact[0]:.2f} s" if wall_contact else f"the plate's corners came within {closest * 1000:.0f} mm of a wall (any side: the sensor looks ahead only)"},
        # Never driving toward anything it could see is not tested, so not a pass.
        {"name": "kept its distance", "pass": bool(nearest_ahead < math.inf and nearest_ahead >= spec["stopBeforeWallMm"]), "detail": (f"driving forward, it came {nearest_ahead:.0f} mm from what was ahead (the brief: at least {spec['stopBeforeWallMm']} mm)" if nearest_ahead < math.inf else f"not tested: it never drove toward anything in range (the brief: at least {spec['stopBeforeWallMm']} mm)")},
        {"name": "turned away", "pass": turned_at is not None, "detail": "turned more than 45° from its start" if turned_at else "never turned away"},
        {"name": "kept driving", "pass": bool(moved_after_turn >= 0.3), "detail": f"{moved_after_turn:.2f} m after turning (nothing ahead in range: the reading is -1, not 0 mm)"},
        {"name": "top speed", "pass": bool(top_speed >= 0.9 * target), "detail": f"{top_speed:.2f} m/s (target {target} m/s, 90 % needed)"},
        {"name": "peak current", "pass": bool(peak_a <= (spec.get("driverPeakA") or math.inf)), "detail": f"{peak_a:.2f} A per motor (driver peak {spec['driverPeakA']} A)" if spec.get("driverPeakA") else f"{peak_a:.2f} A per motor (driver peak unknown: not checked)"},
    ]
    if opp:
        gap = opp.get("gapMm", 150)
        segments += [
            {"name": "stopped for the opponent", "pass": bool(opp_c is not None and opp_gap * 1000 >= gap), "detail": f"the sensor came within {opp_gap * 1000:.0f} mm of the opponent (at least {gap} mm needed)" if opp_c is not None else "the opponent never appeared (the course ended first)"},
            {"name": "held, didn't turn", "pass": bool(opp_c is not None and math.degrees(opp_turn) < 10), "detail": f"its heading changed {math.degrees(opp_turn):.1f}° while the opponent stood there (under 10° needed)"},
            {"name": "drove on after it left", "pass": bool(opp_after >= 0.1), "detail": f"{opp_after:.2f} m forward in the 3 s after it left (0.1 m needed)"},
        ]
    if tgt and axle0 is not None:
        c, s0 = math.cos(axle0[2]), math.sin(axle0[2])
        wx = axle0[0] + (tgt["xMm"] * c - tgt["yMm"] * s0) / 1000
        wy = axle0[1] + (tgt["xMm"] * s0 + tgt["yMm"] * c) / 1000
        miss = math.hypot(axle_last[0] - wx, axle_last[1] - wy) * 1000
        tol = tgt.get("tolMm", 20)
        segments = [s for s in segments if s["name"] in ("no wall contact", "peak current")] + [
            {"name": "reached the point", "pass": bool(miss <= tol), "detail": f"the axle's middle ended {miss:.1f} mm from ({tgt['xMm']}, {tgt['yMm']}) mm (within {tol} mm needed)"},
            {"name": "came to rest", "pass": bool(rest_speed < 0.01), "detail": f"{rest_speed * 1000:.0f} mm/s at the end"},
        ]
    failed = [s for s in segments if not s["pass"]]
    reason = "; ".join(f"{s['name']}: {s['detail']}" for s in failed) if failed else "every segment passed"
    if wall_contact:
        reason = f"hit the wall ({wall_contact[1]}) at {wall_contact[0]:.2f} s; " + reason
    stats = {"peakA": round(peak_a, 3), "topSpeedMps": round(top_speed, 3), "closestWallMm": round(closest * 1000), "simSeconds": round(data.time, 2), "edgeMm": spec["edgeMm"], "ticks": ticks, "payload": {"tempC": PAYLOAD[0], "rh": PAYLOAD[1]}}
    if tgt and axle0 is not None:
        stats["targetMissMm"] = round(miss, 1)
    return _result(out_dir, "fail" if failed else "pass", reason, segments, stats, trajectory)


def main():
    if len(sys.argv) < 4:
        print("usage: drive.py <chassis-spec.json> <port or unix socket path> <out-dir> [course_s] [realtime]", file=sys.stderr)
        sys.exit(2)
    spec = json.loads(Path(sys.argv[1]).read_text())
    r = run(spec, int(sys.argv[2]) if sys.argv[2].isdigit() else sys.argv[2], sys.argv[3], float(sys.argv[4]) if len(sys.argv) > 4 else 25.0, realtime=len(sys.argv) > 5 and sys.argv[5] == "realtime")
    print(json.dumps({"result": r["result"], "reason": r["reason"]}))


if __name__ == "__main__":
    main()
