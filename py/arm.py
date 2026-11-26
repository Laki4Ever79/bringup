"""The arm's printed parts and their checks (arm task 3, docs/superpowers/plans/2026-11-25-robot-arm-phase1.md).

From a contract's `arm` (src/arm/types.ts), in the arm's frame (origin at the base plate's top centre, +x forward, +y
left, z up; mm), it builds six rigid bodies around the real servo solids (py/parts: SG90, MG996R; the DS3218MG has the
MG996R's standard case):

- base: the plate, the base yaw servo standing on it (shaft up on the yaw axis) in a printed cradle;
- turntable (turned by the base yaw): a disc on the yaw horn and a pedestal holding the shoulder servo, its axis along y
  at shoulderZMm;
- upper arm (shoulder): a U bracket whose two plates straddle the shoulder servo (horn and idler side), carrying the
  elbow servo at its far end;
- forearm (elbow): the same around the elbow servo, carrying the wrist pitch servo;
- wrist (wrist pitch): a U bracket carrying the wrist roll servo, its shaft along the link;
- gripper (wrist roll): a plate on the roll horn with the gripper servo and two fingers reaching the grip point.

Each joint's bracket nests just outside the one before it, so neighbouring brackets don't share a plane. The kinematics
are src/arm/kinematics.ts's (a positive angle raises the link); the brackets' sideways offsets don't move the grip point.

usage: arm.py <contract.json> <out dir>
writes <out>/arm/<part>.step and .stl for each printed part, links.json (ArmLink[]: each moving link's printed mass and
centre of mass in its joint's frame) and interference.json ({poses, pairs, clashes: [{pose, a, b, mm3}], print}).
"""

import json
import math
import sys
from pathlib import Path

from build123d import Box, Cylinder, Location, Pos, Rot, export_step, export_stl

sys.path.insert(0, str(Path(__file__).parent))
import parts  # noqa: E402
from printcheck import bed_issue, support_notes, wall_issues  # noqa: E402

PLA = 1.24  # g/cm³, solid (catalog estimate plaDensityGcm3)
PLATE_T = 3.0  # bracket plate thickness
PLATE_H = 20.0  # bracket plate height (across the link)
GAP = 1.0  # clearance between a servo and the bracket around it, and between nested brackets
CLASH_MM3 = 1.0
SAMPLES = 7
JOINTS = ["base-yaw", "shoulder", "elbow", "wrist-pitch", "wrist-roll"]
# The servo solids by catalog mpn; a standard-size servo without its own model takes the MG996R's case.
SERVO = {"SG90": parts.sg90, "MG996R": parts.mg996r, "DS3218MG": parts.mg996r}


class ArmError(Exception):
    pass


def servo(mpn):
    make = SERVO.get(mpn) or SERVO.get(mpn.split()[0])
    if not make:
        raise ArmError(f"no solid for servo {mpn} (py/parts has {', '.join(SERVO)})")
    return make()


def span(lib):
    """A servo's extent along its shaft axis: (below the mounting face, to the horn's top)."""
    bb = lib.shape.bounding_box()
    return bb.min.Z, lib.frames["horn"].position.Z


def centred_y(lib):
    """The servo turned so its shaft runs along +y, slid along it so its case is centred on y = 0 (its body behind the
    shaft along -x)."""
    lo, hi = span(lib)
    return Pos(0, -(lo + hi) / 2, 0) * Rot(-90, 0, 0) * lib.shape


def u_bracket(x0, x1, half):
    """Two plates at y = ±half (inner faces), from x0 to x1, joined by a cross plate at x1."""
    t, h = PLATE_T, PLATE_H
    plates = [Pos((x0 + x1) / 2, s * (half + t / 2), 0) * Box(x1 - x0, t, h) for s in (1, -1)]
    cross = Pos(x1 - t / 2, 0, 0) * Box(t, 2 * (half + t), h)
    out = plates[0] + plates[1] + cross
    return out


def build(arm):
    """The rigid bodies: [(name, solid in its joint's frame, printed solids [(part name, solid)])]."""
    j = {x["name"]: x for x in arm["joints"]}
    sv = {n: servo(j[n]["servo"]) for n in JOINTS}
    grip = servo(arm["gripper"]["servo"])
    L = {n: j[n]["linkMm"] for n in JOINTS}
    plate_l, plate_w = arm["base"]["plateMm"]
    t = arm["base"]["thicknessMm"]
    sz = arm["base"]["shoulderZMm"]

    # Base: the plate (top at z 0), the yaw servo standing on it, shaft up on the yaw axis, in a cradle.
    yaw = sv["base-yaw"]
    ylo, yhi = span(yaw)
    yaw_solid = Pos(0, 0, -ylo) * yaw.shape
    yb = yaw_solid.bounding_box()
    plate = Pos(0, 0, -t / 2) * Box(plate_l, plate_w, t)
    cw = 2.0
    cradle = Pos(yb.center().X, yb.center().Y, 10) * Box(yb.size.X + 2 * (cw + GAP), yb.size.Y + 2 * (cw + GAP), 20) - Pos(yb.center().X, yb.center().Y, 10) * Box(yb.size.X + 2 * GAP, yb.size.Y + 2 * GAP, 22)
    base_printed = plate + cradle
    horn_top = yhi - ylo

    # Turntable: a disc on the yaw horn, a pedestal up to the shoulder servo's case.
    sh = sv["shoulder"]
    sh_solid = Pos(L["base-yaw"], 0, sz) * centred_y(sh)
    sb = sh_solid.bounding_box()
    if sb.min.Z < horn_top + 4 + GAP:
        raise ArmError(f"the shoulder axis at {sz:g} mm leaves no room for the turntable: the shoulder servo's case comes down to {sb.min.Z:.1f} mm, the base servo's horn is at {horn_top:.1f} mm (+4 mm disc); raise base.shoulderZMm to at least {sz + horn_top + 4 + GAP - sb.min.Z:.0f}")
    disc = Pos(0, 0, horn_top + 2) * Cylinder(max(30, (sb.size.X + 10) / 2), 4)
    ped_h = sb.min.Z - (horn_top + 4)
    pedestal = Pos(sb.center().X, 0, horn_top + 4 + ped_h / 2) * Box(sb.size.X, sb.size.Y, max(ped_h, 0.5))
    turntable = disc + pedestal

    # Each pitch link: a U bracket straddling its own servo, out to the next joint; the next servo fixed in it.
    def half_for(lib):
        lo, hi = span(lib)
        return (hi - lo) / 2 + GAP

    h_sh = half_for(sh)
    h_el = max(half_for(sv["elbow"]), h_sh + PLATE_T + GAP)
    h_wp = max(half_for(sv["wrist-pitch"]), h_el + PLATE_T + GAP)
    hub = 12.0  # the bracket reaches this far behind its joint's axis, round the horn and the idler
    upper = u_bracket(-hub, L["shoulder"] + hub, h_sh)
    el_solid = Pos(L["shoulder"], 0, 0) * centred_y(sv["elbow"])
    fore = u_bracket(-hub, L["elbow"] + hub, h_el)
    wp_solid = Pos(L["elbow"], 0, 0) * centred_y(sv["wrist-pitch"])
    # Wrist: a U bracket round the wrist pitch servo, carrying the roll servo shaft along +x at the link's end.
    wr = sv["wrist-roll"]
    rlo, rhi = span(wr)
    roll_solid = Pos(L["wrist-pitch"] - rhi, 0, 0) * Rot(0, 90, 0) * wr.shape
    wrist = u_bracket(-hub, max(L["wrist-pitch"] - (rhi - rlo) - GAP, 1.0), h_wp)
    # Gripper: a plate on the roll horn, the gripper servo on it, two fingers out to the grip point.
    g = arm["gripper"]
    reach = L["wrist-roll"]
    gplate = Pos(2, 0, 0) * Box(4, 30, 30)
    finger_l = g["fingerMm"]
    fingers = [Pos(reach - finger_l / 2, s * (g["openMm"] / 2 + 2), 0) * Box(finger_l, 4, 10) for s in (1, -1)]
    palm = Pos((4 + reach - finger_l) / 2 + 2, 0, 0) * Box(max(reach - finger_l - 4, 2), g["openMm"] + 8, 10)
    # The gripper servo on top of the palm, its case pointing forward (away from the wrist, so a rolled gripper keeps it
    # clear of the forearm), its shaft driving the fingers' linkage.
    gs = Pos(8, 0, 5 + 0.1 - grip.shape.bounding_box().min.Z) * Rot(0, 0, 180) * grip.shape
    gripper = gplate + palm + fingers[0] + fingers[1]

    return [
        ("base", plate + yaw_solid + cradle, [("base plate", base_printed)]),
        ("turntable", turntable + sh_solid, [("turntable", turntable)]),
        ("upper arm", upper + el_solid, [("upper arm bracket", upper)]),
        ("forearm", fore + wp_solid, [("forearm bracket", fore)]),
        ("wrist", wrist + roll_solid, [("wrist bracket", wrist)]),
        ("gripper", gripper + gs, [("gripper", gripper)]),
    ]


def poses_of(arm, deg):
    """Each body's Location for joint angles in degrees (ARM_JOINTS order); kinematics.ts forward's frames."""
    j = {x["name"]: x for x in arm["joints"]}
    yaw, sh, el, wp, roll = deg
    base = Location()
    t_yaw = Rot(0, 0, yaw)
    t_sh = t_yaw * Pos(j["base-yaw"]["linkMm"], 0, arm["base"]["shoulderZMm"]) * Rot(0, -sh, 0)
    t_el = t_sh * Pos(j["shoulder"]["linkMm"], 0, 0) * Rot(0, -el, 0)
    t_wp = t_el * Pos(j["elbow"]["linkMm"], 0, 0) * Rot(0, -wp, 0)
    t_wr = t_wp * Pos(j["wrist-pitch"]["linkMm"], 0, 0) * Rot(roll, 0, 0)
    return [base, t_yaw, t_sh, t_el, t_wp, t_wr]


def _overlap(a, b):
    x, y = a.bounding_box(), b.bounding_box()
    return all(lo_a < hi_b and lo_b < hi_a for lo_a, hi_a, lo_b, hi_b in zip(tuple(x.min), tuple(x.max), tuple(y.min), tuple(y.max)))


def sweep_poses(arm, extra=()):
    """SAMPLES angles per joint across its limits, each crossed with its neighbouring joint's (the others at the middle of
    their range), plus the given poses (the pick and drop)."""
    lim = [(x["minDeg"], x["maxDeg"]) for x in arm["joints"]]
    mid = [max(lo, min(hi, 0.0)) for lo, hi in lim]
    samples = [[lo + (hi - lo) * k / (SAMPLES - 1) for k in range(SAMPLES)] for lo, hi in lim]
    out = []
    for i in range(len(lim) - 1):
        for a in samples[i]:
            for b in samples[i + 1]:
                p = list(mid)
                p[i], p[i + 1] = a, b
                out.append(tuple(round(v, 3) for v in p))
    out += [tuple(p) for p in extra]
    return list(dict.fromkeys(out))


def interference(arm, bodies, poses):
    """Every pair of bodies not joined at a joint, at every pose: their common volume. Neighbouring bodies (one turns
    the other) are left out: their servo's horn is meant to touch the bracket."""
    clashes, pairs = [], 0
    for pose in poses:
        locs = poses_of(arm, pose)
        placed = [(name, locs[k] * solid) for k, (name, solid, _) in enumerate(bodies)]
        for a in range(len(placed)):
            for b in range(a + 2, len(placed)):
                pairs += 1
                (na, sa), (nb, sb) = placed[a], placed[b]
                if not _overlap(sa, sb):
                    continue
                try:
                    common = sa & sb
                    v = common.volume if common is not None else 0.0
                except Exception:  # noqa: BLE001 - a failed boolean is reported, never a pass
                    v = float("nan")
                if not v <= CLASH_MM3:
                    clashes.append({"pose": [round(x, 1) for x in pose], "a": na, "b": nb, "mm3": round(v, 1) if v == v else None})
    return pairs, clashes


def links(bodies):
    """Each moving link's printed mass (solid PLA) and centre of mass, in its joint's frame (ArmLink)."""
    names = ["base-yaw", "shoulder", "elbow", "wrist-pitch", "wrist-roll"]
    out = []
    for name, (_, _, printed) in zip(names + ["gripper"], bodies[1:]):
        solid = printed[0][1]
        c = solid.center()
        out.append({"name": name if name != "wrist-roll" else "wrist-roll", "massG": round(solid.volume / 1000 * PLA, 1), "comMm": [round(c.X, 1), round(c.Y, 1), round(c.Z, 1)]})
    # The gripper body is turned by the wrist roll: its printed mass is the "gripper" link, the wrist roll's own link is
    # the gripper plate's (one rigid body, reported as the gripper).
    out[-1]["name"] = "gripper"
    return out


def main():
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    values = json.loads(Path(sys.argv[1]).read_text())
    values = values.get("values", values)
    arm, targets = values["arm"], values.get("armTargets")
    out = Path(sys.argv[2]) / "arm"
    out.mkdir(parents=True, exist_ok=True)
    try:
        bodies = build(arm)
    except ArmError as e:
        (out / "interference.json").write_text(json.dumps({"error": str(e)}))
        print(str(e), file=sys.stderr)
        sys.exit(1)
    printed = [p for _, _, ps in bodies for p in ps]
    for name, solid in printed:
        stem = name.replace(" ", "-")
        export_step(solid, str(out / f"{stem}.step"))
        export_stl(solid, str(out / f"{stem}.stl"))
    (out / "links.json").write_text(json.dumps(links(bodies), indent=1))
    extra = []
    if targets:
        # The pick and drop poses, solved by the TS side (src/tools/arm.ts passes them in the contract as armPoses).
        extra = values.get("armPoses", [])
    poses = sweep_poses(arm, extra)
    pairs, clashes = interference(arm, bodies, poses)
    bed = arm.get("printBedMm", [256, 256, 256])
    issues = [i for i in (bed_issue(n, s, bed) for n, s in printed) if i] + wall_issues({"bracket plate": PLATE_T})
    notes = [n for name, s in printed for n in support_notes(name, s)]
    (out / "interference.json").write_text(json.dumps({"poses": len(poses), "pairs": pairs, "clashes": clashes, "print": {"ok": not issues, "issues": issues, "notes": notes, "bedMm": bed}}, indent=1))


if __name__ == "__main__":
    main()
