"""Firmware in the loop for the robot arm: its firmware (in QEMU) drives the MuJoCo arm through the pick-and-place.

Usage: arm_drive.py <arm-sim-spec.json> <port> <out-dir> [limit_s]

The firmware's simulation build talks over UART1 in lock-step (templates/fw-arm/SIM.md): its servo driver's I2C writes
arrive as "I <addr> <bytes…>" (hex) and go to a model of the chip (Pca9685 below: registers → each channel's pulse →
the servo's angle → the joint's); "T <tick>" ends a tick: this bridge sets each position actuator's target, steps the
physics by one control period and answers "S <now_ms>". "E <tick>" ends the run.

The spec (src/tools/drive.ts runArmDrive writes it):
  mjcf: the model file (py/mech/arm_model.py); its position actuators are named after the joints and "gripper", and
        it has a free body "cube"
  joints: the actuator names in the firmware's order; gripper: {closedDeg, openDeg, closedQ, openQ}, the firmware's
        gripper angle mapped linearly onto the gripper actuator's target
  pca: {addr, hz}; servos: one per joint then the gripper, {channel, minDeg, maxDeg, rangeDeg, pulseUs: [us0, us1]}
        (the firmware's servo map, src/arm/firmware.ts armServos)
  periodMs: one control tick; repeats: the cycles the firmware runs
  spawn: [x, y, z] mm, where a new cube is placed; absent, where the model put the first one (arm_model.py: resting on
         the plate at the pick point)
  cup: {xMm, yMm, innerRMm, rimZMm}
The gripper's closedQ/openQ and the cup's innerRMm/rimZMm, when the spec leaves them out, come from the model's module
(py/mech/arm_model.py: GRIPPER_CLOSED_Q, GRIPPER_OPEN_Q, CUP_INNER_MM, CUP_RIM_MM): one number for model and judge.

A cube that has left the height it was placed at (LIFTED_MM: picked up) and has then come to rest (under SETTLE_MPS for
SETTLE_S) away from it, with the gripper commanded open, has been dropped (one only nudged is still waiting to be picked):
it landed when its centre is within the cup's inner radius and below its rim, else it missed.
Either way a new cube is placed at the spawn point for the next cycle. Pass: every cycle's cube landed.
Results: arm.json (result, reason, landed, attempts, worstMm, cycleS, drops: each cube's rest point, i2c: what the chip
model saw) in out-dir.
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
LIFTED_MM = 10  # how far a cube must have left its placed height: one the opening gripper only nudged was never picked


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


class Pca9685:
    """The NXP PCA9685 (datasheet rev 4) as far as a servo driver uses it: MODE1 (0x00) SLEEP (bit 4) and AI (bit 5),
    PRE_SCALE (0xFE, written only while asleep, 7.3.5), LEDn_ON/OFF (0x06 + 4n, 12 bits, 7.3.3), the 25 MHz oscillator.
    write() takes one I2C transaction: the register pointer, then data, the pointer auto-incrementing only with AI."""

    OSC_HZ = 25_000_000

    def __init__(self):
        self.reg = [0] * 256
        self.reg[0x00] = 0x11  # power-on MODE1: asleep, ALLCALL (7.3.1)
        self.reg[0xFE] = 0x1E  # power-on PRE_SCALE: 200 Hz
        self.writes = 0
        self.ignored_prescale = 0

    def write(self, data):
        if not data:
            return
        self.writes += 1
        ptr = data[0]
        for b in data[1:]:
            if ptr == 0xFE and not self.reg[0x00] & 0x10:
                self.ignored_prescale += 1  # the chip blocks PRE_SCALE writes while awake
            else:
                self.reg[ptr] = b
            if self.reg[0x00] & 0x20:
                ptr = (ptr + 1) & 0xFF
                if ptr == 0xFE + 1:
                    ptr = 0  # (past PRE_SCALE: wraps)

    def hz(self):
        return self.OSC_HZ / (4096 * (self.reg[0xFE] + 1))

    def pulse_us(self, ch):
        """The channel's high time in microseconds, or None while asleep or off."""
        if self.reg[0x00] & 0x10:
            return None
        r = 0x06 + 4 * ch
        on = self.reg[r] | (self.reg[r + 1] & 0x0F) << 8
        off = self.reg[r + 2] | (self.reg[r + 3] & 0x0F) << 8
        if self.reg[r + 3] & 0x10:  # full off
            return None
        if self.reg[r + 1] & 0x10:  # full on
            return 1e6 / self.hz()
        ticks = (off - on) % 4096
        return None if ticks == 0 else ticks * 1e6 / (4096 * self.hz())


def joint_deg(us, servo):
    """A servo's pulse back to its joint angle: the inverse of the firmware's arm_servo_deg (offset 0) and arm_pulse_us."""
    us0, us1 = servo["pulseUs"]
    s = (us - us0) / (us1 - us0) * servo["rangeDeg"]
    s = min(servo["rangeDeg"], max(0.0, s))
    return s + servo["minDeg"] - (servo["rangeDeg"] - (servo["maxDeg"] - servo["minDeg"])) / 2


def landed(pos_m, cup):
    """(landed, horizontal distance mm from the cup's centre) for a cube centre at rest."""
    d = math.hypot(pos_m[0] * 1000 - cup["xMm"], pos_m[1] * 1000 - cup["yMm"])
    return bool(d < cup["innerRMm"] and pos_m[2] * 1000 < cup["rimZMm"]), float(d)


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


# The bodies whose poses the trajectory records (py/arm_pictures.py moves each posed STL group by its body's), and the
# sampling interval in simulated seconds.
TRACKED = ("turntable", "upper-arm", "forearm", "wrist", "gripper-body", "finger-left", "finger-right", "cube")
SAMPLE_S = 0.05


def _pose(model, data, name):
    b = model.body(name).id
    return [round(float(v), 5) for v in (*data.xpos[b], *data.xquat[b])]


def run(spec, port, out_dir, limit_s=600.0, firmware_wait_s=60.0, tick_wait_s=10.0):
    """The pick-and-place; also writes trajectory.json (the tracked bodies' poses over time, the cup's walls) once the
    firmware has run, for the pictures of it."""
    rec = {"frames": []}
    r = _run(spec, port, out_dir, limit_s, firmware_wait_s, tick_wait_s, rec)
    if rec["frames"]:
        (Path(out_dir) / "trajectory.json").write_text(json.dumps({k: v for k, v in rec.items()}))
    return r


def _run(spec, port, out_dir, limit_s, firmware_wait_s, tick_wait_s, rec):
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

    # The trajectory's fixed parts: each tracked body at rest (the posed STLs' pose), the cup's wall boxes, the cube's size.
    tracked = [n for n in TRACKED if mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY, n) >= 0]
    rec["bodies"] = tracked
    # The joints' angles too (degrees, spec joints order): py/arm_pictures.py poses the printed parts with py/arm.py's
    # own kinematics, the frame the posed STLs were made in.
    rec["joints"] = list(spec["joints"])
    jq = [model.jnt_qposadr[model.joint(n).id] for n in spec["joints"]]
    rec["rest"] = {n: _pose(model, data, n) for n in tracked}
    rec["cup"] = [{"pos": [round(float(v), 5) for v in data.geom_xpos[g]], "mat": [round(float(v), 5) for v in data.geom_xmat[g]], "size": [round(float(v), 5) for v in model.geom_size[g]]} for g in range(model.ngeom) if (model.geom(g).name or "").startswith("cup-")]
    rec["cubeHalf"] = [round(float(v), 5) for v in model.geom_size[model.geom("cube").id]] if mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM, "cube") >= 0 else [0.0125] * 3
    next_sample = 0.0

    sock = _connect(port, firmware_wait_s)
    if sock is None:
        return _result(out_dir, "not run", f"the firmware didn't answer within {firmware_wait_s:g} s (no connection)")
    sock.settimeout(firmware_wait_s)
    f = sock.makefile("rw", newline="\n")

    placed_at = data.xpos[cube.id].copy()
    still_since = None
    cycle_start = 0.0
    landings, cycles, drops = [], [], []
    lifted = False
    pca, pca_addr, servos = Pca9685(), spec["pca"]["addr"], spec["servos"]
    other_addr = set()
    deg = [None] * len(servos)
    ticks = 0
    grip_open = False  # open only once the chip's output says so (an unpowered servo opens nothing)
    stats = lambda: {"landed": sum(1 for ok, _ in landings if ok), "attempts": len(landings), "worstMm": round(max((d for _, d in landings), default=0.0), 1), "cycleS": [round(c, 2) for c in cycles], "simS": round(data.time, 2), "drops": drops, "i2c": {"writes": pca.writes, "hz": round(pca.hz(), 2), "ignoredPrescale": pca.ignored_prescale, "otherAddr": sorted(other_addr)}}
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
        if parts and parts[0] == "I" and len(parts) >= 2:
            try:
                addr, payload = int(parts[1], 16), [int(x, 16) for x in parts[2:]]
            except ValueError:
                continue
            if addr == pca_addr:
                pca.write(payload)
            else:
                other_addr.add(addr)
            continue
        if not parts or parts[0] != "T":
            continue
        if ticks == 0:
            sock.settimeout(tick_wait_s)
        ticks += 1
        # The chip's outputs → joint targets; a channel with no pulse (asleep, off) leaves its servo where it was.
        for i, sv in enumerate(servos):
            us = pca.pulse_us(sv["channel"])
            if us is not None:
                deg[i] = joint_deg(us, sv)
        for a, d in zip(acts, deg[:5]):
            if d is not None:
                data.ctrl[a] = math.radians(d)
        if deg[5] is not None:
            data.ctrl[grip_act] = grip_target(deg[5], grip)
            grip_open = deg[5] >= (grip["closedDeg"] + grip["openDeg"]) / 2
        for _ in range(steps):
            mujoco.mj_step(model, data)
        # MuJoCo resets the state when it blows up (NaN accelerations): a model problem, never a quiet restart.
        if data.warning[mujoco.mjtWarning.mjWARN_BADQACC].number > 0:
            return _result(out_dir, "fail", f"the simulation went unstable at {data.time:.3f} s (MuJoCo: bad accelerations): a model problem", stats())
        if data.time >= next_sample:
            rec["frames"].append([round(data.time, 3), [_pose(model, data, n) for n in tracked], [round(math.degrees(float(data.qpos[q])), 2) for q in jq]])
            next_sample = data.time + SAMPLE_S
        # A dropped cube: at rest, away from where it was placed, the gripper open.
        pos = data.xpos[cube.id]
        speed = float(np.linalg.norm(data.qvel[cube_v:cube_v + 3]))
        moved = np.linalg.norm(pos - placed_at) * 1000 > MOVED_MM
        lifted = lifted or abs(pos[2] - placed_at[2]) * 1000 > LIFTED_MM  # picked up, or (a test's cube placed in the air) fallen
        if speed < SETTLE_MPS and moved and lifted and grip_open:
            still_since = data.time if still_since is None else still_since
            if data.time - still_since >= SETTLE_S:
                landings.append(landed(pos, cup))
                drops.append({"tS": round(data.time, 2), "atMm": [round(float(v) * 1000, 1) for v in pos], "fromCupMm": round(landings[-1][1], 1), "landed": landings[-1][0]})
                cycles.append(data.time - cycle_start)
                cycle_start = data.time
                place()
                placed_at = data.xpos[cube.id].copy()
                lifted = False
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
