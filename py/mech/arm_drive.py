"""Firmware in the loop for the robot arm: its firmware (in QEMU) drives the MuJoCo arm through the pick-and-place.

Usage: arm_drive.py <arm-sim-spec.json> <port> <out-dir> [limit_s]

The firmware's simulation build talks over UART1 in lock-step, one line each way per control tick
(templates/fw-arm/SIM.md): "A <tick> <deg0> … <deg5>" from the firmware, the joints in ARM_JOINTS order then the
gripper; this bridge sets each position actuator's target, steps the physics by one control period and answers
"S <now_ms>". "E <tick>" ends the run.

The spec (src/tools/drive.ts runArmDrive writes it):
  mjcf: the model file (py/mech/arm_model.py); its position actuators are named after the joints and "gripper", and
        it has a free body "cube" and the cup at `cup`
  joints: the actuator names in the firmware's order; gripper: {closedDeg, openDeg, closedQ, openQ}, the firmware's
        gripper angle mapped linearly onto the gripper actuator's target
  periodMs: one control tick; repeats: the cycles the firmware runs
  spawn: [x, y, z] mm, where a new cube is placed; absent, where the model put the first one (arm_model.py: resting on
         the plate at the pick point)
  cup: {xMm, yMm, innerRMm, rimZMm}
The gripper's closedQ/openQ and the cup's innerRMm/rimZMm, when the spec leaves them out, come from the model's module
(py/mech/arm_model.py: GRIPPER_CLOSED_Q, GRIPPER_OPEN_Q, CUP_INNER_MM, CUP_RIM_MM): one number for model and judge.

A cube that has come to rest (under SETTLE_MPS for SETTLE_S) away from where it was placed, with the gripper commanded
open, has been dropped: it landed when its centre is within the cup's inner radius and below its rim, else it missed.
Either way a new cube is placed at the spawn point for the next cycle. Pass: every cycle's cube landed.
Results: arm.json (result, reason, landed, attempts, worstMm, cycleS) in out-dir.
"""

import json
import math
import socket
import sys
import time
from pathlib import Path

import mujoco
import numpy as np

SETTLE_MPS = 0.01
SETTLE_S = 0.3
MOVED_MM = 20  # how far from its spawn a cube must be to count as dropped (one still in place hasn't been picked)


def _result(out_dir, result, reason, stats=None):
    r = {"result": result, "reason": reason, **(stats or {})}
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "arm.json").write_text(json.dumps(r, indent=1))
    return r


def _connect(port, wait_s):
    """port: a TCP port on 127.0.0.1, or the path of the Unix socket QEMU serves."""
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


def landed(pos_m, cup):
    """(landed, horizontal distance mm from the cup's centre) for a cube centre at rest."""
    d = math.hypot(pos_m[0] * 1000 - cup["xMm"], pos_m[1] * 1000 - cup["yMm"])
    return d < cup["innerRMm"] and pos_m[2] * 1000 < cup["rimZMm"], d


def grip_target(deg, g):
    """The firmware's gripper angle onto the gripper actuator's target, linearly closed..open."""
    span = g["openDeg"] - g["closedDeg"]
    s = 0.0 if span == 0 else (deg - g["closedDeg"]) / span
    return g["closedQ"] + (g["openQ"] - g["closedQ"]) * min(1.0, max(0.0, s))


MODEL_DEFAULTS = (("gripper", "closedQ", "GRIPPER_CLOSED_Q"), ("gripper", "openQ", "GRIPPER_OPEN_Q"), ("cup", "innerRMm", "CUP_INNER_MM"), ("cup", "rimZMm", "CUP_RIM_MM"))


def with_model_defaults(spec):
    """The spec with any missing gripper/cup number taken from py/mech/arm_model.py."""
    missing = [(sec, key, const) for sec, key, const in MODEL_DEFAULTS if spec[sec].get(key) is None]
    if not missing:
        return spec
    from mech import arm_model  # only when needed: the toy-model tests pass every number
    out = {**spec, "gripper": dict(spec["gripper"]), "cup": dict(spec["cup"])}
    for sec, key, const in missing:
        out[sec][key] = getattr(arm_model, const)
    return out


def run(spec, port, out_dir, limit_s=600.0, firmware_wait_s=60.0, tick_wait_s=10.0):
    try:
        spec = with_model_defaults(spec)
    except (ImportError, AttributeError) as e:
        return _result(out_dir, "not run", f"the arm model's constants are missing (py/mech/arm_model.py): {e}")
    model = mujoco.MjModel.from_xml_path(spec["mjcf"])
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
    acts = [model.actuator(n).id for n in spec["joints"]]
    grip = spec["gripper"]
    grip_act = model.actuator("gripper").id
    cube = model.body("cube")
    cube_q = model.jnt_qposadr[cube.jntadr[0]]
    cube_v = model.jnt_dofadr[cube.jntadr[0]]
    steps = max(1, round(spec["periodMs"] / 1000 / model.opt.timestep))
    cup = spec["cup"]
    spawn = np.array(spec["spawn"], dtype=float) / 1000 if spec.get("spawn") is not None else data.qpos[cube_q:cube_q + 3].copy()

    def place():
        data.qpos[cube_q:cube_q + 3] = spawn
        data.qpos[cube_q + 3:cube_q + 7] = [1, 0, 0, 0]
        data.qvel[cube_v:cube_v + 6] = 0
        mujoco.mj_forward(model, data)

    sock = _connect(port, firmware_wait_s)
    if sock is None:
        return _result(out_dir, "not run", f"the firmware didn't answer within {firmware_wait_s:g} s (no connection)")
    sock.settimeout(firmware_wait_s)
    f = sock.makefile("rw", newline="\n")

    placed_at = data.xpos[cube.id].copy()
    still_since = None
    cycle_start = 0.0
    landings, cycles = [], []
    ticks = 0
    grip_open = True
    stats = lambda: {"landed": sum(1 for ok, _ in landings if ok), "attempts": len(landings), "worstMm": round(max((d for _, d in landings), default=0.0), 1), "cycleS": [round(c, 2) for c in cycles], "simS": round(data.time, 2)}
    while data.time < limit_s:
        try:
            line = f.readline()
        except (socket.timeout, TimeoutError, OSError):
            line = ""
        if not line:
            if ticks == 0:
                return _result(out_dir, "not run", f"the firmware didn't answer within {firmware_wait_s:g} s")
            return _result(out_dir, "fail", f"the firmware stopped answering at {data.time:.2f} s", stats())
        parts = line.split()
        if parts and parts[0] == "E":
            break
        if len(parts) < 8 or parts[0] != "A":
            continue
        if ticks == 0:
            sock.settimeout(tick_wait_s)
        ticks += 1
        deg = [float(x) for x in parts[2:8]]
        for a, d in zip(acts, deg[:5]):
            data.ctrl[a] = math.radians(d)
        data.ctrl[grip_act] = grip_target(deg[5], grip)
        grip_open = deg[5] >= (grip["closedDeg"] + grip["openDeg"]) / 2
        for _ in range(steps):
            mujoco.mj_step(model, data)
        # MuJoCo resets the state when it blows up (NaN accelerations): a model problem, never a quiet restart.
        if data.warning[mujoco.mjtWarning.mjWARN_BADQACC].number > 0:
            return _result(out_dir, "fail", f"the simulation went unstable at {data.time:.3f} s (MuJoCo: bad accelerations): a model problem", stats())
        # A dropped cube: at rest, away from where it was placed, the gripper open.
        pos = data.xpos[cube.id]
        speed = float(np.linalg.norm(data.qvel[cube_v:cube_v + 3]))
        moved = np.linalg.norm(pos - placed_at) * 1000 > MOVED_MM
        if speed < SETTLE_MPS and moved and grip_open:
            still_since = data.time if still_since is None else still_since
            if data.time - still_since >= SETTLE_S:
                landings.append(landed(pos, cup))
                cycles.append(data.time - cycle_start)
                cycle_start = data.time
                place()
                placed_at = data.xpos[cube.id].copy()
                still_since = None
        else:
            still_since = None
        f.write(f"S {int(round(data.time * 1000))}\n")
        f.flush()
    s = stats()
    want = spec["repeats"]
    if s["attempts"] < want:
        return _result(out_dir, "fail", f"{s['attempts']} of {want} cubes were dropped before the firmware ended", s)
    if s["landed"] < want:
        return _result(out_dir, "fail", f"{s['landed']} of {want} cubes landed in the cup (worst {s['worstMm']} mm from its centre)", s)
    return _result(out_dir, "pass", f"{s['landed']} of {want} cubes landed in the cup (worst {s['worstMm']} mm from its centre)", s)


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(2)
    spec = json.loads(Path(sys.argv[1]).read_text())
    r = run(spec, int(sys.argv[2]) if sys.argv[2].isdigit() else sys.argv[2], sys.argv[3], float(sys.argv[4]) if len(sys.argv) > 4 else 600.0)
    print(json.dumps(r))


if __name__ == "__main__":
    main()
