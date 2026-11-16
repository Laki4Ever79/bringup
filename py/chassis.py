"""A rover's 3D-printable chassis from its mechanics contract (docs/mechanics.md).

Usage: chassis.py <spec.json> <out-dir>  →  chassis.step, chassis.stl, mounts.json

The spec (src/tools/chassis.ts chassisSpec) is in the chassis frame: origin at the plate's centre, +x forward, +y left,
millimetres. Here z = 0 is the plate's underside (the rover's clearance is added by whoever places it). The part:
the plate; under it, a cradle per motor and the caster's four bolt holes; on it, two rails that keep the battery in
place, a standoff under each of the board's mounting holes (a pilot for its M2 screw), and an upright bracket the distance sensor's breakout screws
to at the front. mounts.json lists the hole centres measured back from the built solid, so the board and caster are
checked against what was really made.
"""

import json
import sys
from pathlib import Path

from build123d import Box, Cylinder, GeomType, Pos, Rot, export_step, export_stl

STANDOFF_OD = 5.0
M25_HOLE = 2.7  # an M2.5 screw's clearance hole: the standoff hole of a spec from before boardScrew
WALL = 2.0
CLAMP_BOSS = 4.0  # chassis.ts CLAMP_BOSS_MM
RAIL_H = 3.0


class ChassisError(Exception):
    pass


def _check(spec):
    p = spec["plate"]
    hl, hw = p["lengthMm"] / 2, p["widthMm"] / 2

    for b in spec["boards"]:
        w, h = (b["heightMm"], b["widthMm"]) if b["rotDeg"] in (90, 270) else (b["widthMm"], b["heightMm"])
        if abs(b["xMm"]) + w / 2 > hl + 1e-6 or abs(b["yMm"]) + h / 2 > hw + 1e-6:
            raise ChassisError(f"board {b['name']} ({w} x {h} mm at {b['xMm']}, {b['yMm']}) doesn't fit on the {p['lengthMm']} x {p['widthMm']} mm plate")

    def on_plate(what, x, y, w, h):
        if abs(x) + w / 2 > hl + 1e-6 or abs(y) + h / 2 > hw + 1e-6:
            raise ChassisError(f"the {what} ({w:g} x {h:g} mm at {x:g}, {y:g}) doesn't fit on the {p['lengthMm']} x {p['widthMm']} mm plate")

    bat = spec["battery"]
    on_plate("battery", bat["xMm"], bat["yMm"], bat["sizeMm"][0], bat["sizeMm"][1])
    c = spec["caster"]
    xs = [c["xMm"] + dx for dx, _ in c["holesMm"]]
    ys = [dy for _, dy in c["holesMm"]]
    on_plate("caster's bolt holes", (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, max(xs) - min(xs), max(ys) - min(ys))
    sen = spec["sensor"]
    on_plate("sensor bracket", sen["xMm"] - sen["sizeMm"][2] / 2 - WALL / 2, sen["yMm"], WALL, sen["sizeMm"][0] + 2 * WALL)


def _board_holes(b):
    """The board's own mounting holes on the plate (the spec's, from the board: chassis.ts boardHoles; a bought module's
    from its record). A HAT stands on its board's spacers: no standoffs of its own. A spec from before holes were sent:
    holesMm, else the four corners at holeInsetMm."""
    if b.get("standoffs") is False:
        return []
    if "holes" in b:
        return [(h["xMm"], h["yMm"]) for h in b["holes"]]
    if b.get("holesMm"):
        return [(x, y) for x, y in b["holesMm"]]
    w, h = (b["heightMm"], b["widthMm"]) if b["rotDeg"] in (90, 270) else (b["widthMm"], b["heightMm"])
    i = b.get("holeInsetMm", 3.5)
    return [(b["xMm"] + sx * (w / 2 - i), b["yMm"] + sy * (h / 2 - i)) for sx in (-1, 1) for sy in (-1, 1)]


def build(spec):
    """The chassis part and its measured mounts. Raises ChassisError when the spec can't be built."""
    _check(spec)
    p = spec["plate"]
    t = p["thicknessMm"]
    so = spec.get("standoffMm", 10)
    part = Pos(0, 0, t / 2) * Box(p["lengthMm"], p["widthMm"], t)

    # A standoff under each of the board's mounting holes, with a pilot hole for the board's screw (the case's: an M2
    # self-tapping screw into a 1.6 mm pilot, spec boardScrew) through standoff and plate.
    # Each board's own pilot when the spec gives one (a Raspberry Pi's Ø2.7 mm holes take M2.5, spec boards[].pilotMm).
    pilot = spec.get("boardScrew", {}).get("pilotMm", M25_HOLE)
    holes = []
    for b in spec["boards"]:
        for x, y in _board_holes(b):
            part += Pos(x, y, t + so / 2) * Cylinder(STANDOFF_OD / 2, so)
            holes.append((x, y, b.get("pilotMm", pilot)))
    for x, y, d in holes:
        part -= Pos(x, y, (t + so) / 2) * Cylinder(d / 2, t + so + 2)
    pilots = sorted({d for _, _, d in holes}) or [pilot]

    # The caster's bolt holes.
    c = spec["caster"]
    for dx, dy in c["holesMm"]:
        part -= Pos(c["xMm"] + dx, dy, t / 2) * Cylinder(c["holeDiaMm"] / 2, t + 2)

    # A cradle under the plate per motor, down to the axle (axleDropMm under the plate): a block around the body with
    # the body cut out, axis along y.
    # How each is held (chassis.ts motorMount): a bought bracket screwed through the plate (no cradle), or the cradle with
    # two bosses beside it for the printed clamp's self-tapping screws.
    clamp_screws = []
    for m in spec["motors"]:
        L, W, H = m["bodyMm"]
        mount = m.get("mount", {"kind": "clamp"})
        if mount["kind"] == "bracket":
            for h in mount["holes"]:
                part -= Pos(h["xMm"], h["yMm"], t / 2) * Cylinder(mount["holeDiaMm"] / 2, t + 2)
            continue
        drop = max(m.get("axleDropMm", H / 2 + WALL), H / 2 + WALL)
        depth = drop + H / 2 + WALL
        block = Pos(m["xMm"], m["yMm"], -depth / 2) * Box(W + 2 * WALL, L, depth)
        body = Pos(m["xMm"], m["yMm"], -drop) * Box(W, L + 2, H)
        part += block - body
        if mount["kind"] == "clamp":
            boss = mount["clampMm"][1]
            for h in mount["screwHoles"]:
                part += Pos(h["xMm"], h["yMm"], -depth / 2) * Box(CLAMP_BOSS, boss, depth)
                part -= Pos(h["xMm"], h["yMm"], -depth + 4) * Cylinder(mount["pilotMm"] / 2, 8.01)
                clamp_screws.append(h)

    # Battery rails along its long sides.
    bat = spec["battery"]
    bl, bw = bat["sizeMm"][0], bat["sizeMm"][1]
    for s in (-1, 1):
        part += Pos(bat["xMm"], bat["yMm"] + s * (bw / 2 + WALL / 2), t + RAIL_H / 2) * Box(bl, WALL, RAIL_H)

    # The sensor's bracket: an upright plate just behind the breakout, up to its top.
    sen = spec["sensor"]
    sw, sh, sd = sen["sizeMm"]
    top = sen["zMm"] - p["clearanceMm"] + sh / 2
    height = max(top - t, 5)
    bx = sen["xMm"] - sd / 2 - WALL / 2
    part += Pos(bx, sen["yMm"], t + height / 2) * Box(WALL, sw + 2 * WALL, height)
    # The breakout's screw holes through the bracket (chassis.ts sensorHoles: the ones above the plate).
    for h in sen.get("holes", []):
        part -= Pos(bx, h["yMm"], h["zMm"]) * Rot(0, 90, 0) * Cylinder(sen["holeDiaMm"] / 2, WALL + 2)

    # Measure the holes back from the solid: the circular edges of each hole size, by centre.
    def centres(radius):
        found = []
        for e in part.edges().filter_by(GeomType.CIRCLE):
            if e.radius is not None and abs(e.radius - radius) < 0.05:
                c0 = e.arc_center
                cx, cy = round(c0.X, 3), round(c0.Y, 3)
                if not any(abs(cx - x) < 0.05 and abs(cy - y) < 0.05 for x, y in found):
                    found.append((cx, cy))
        return [{"xMm": x, "yMm": y} for x, y in found]

    sensor_holes = []
    if sen.get("holes"):
        for e in part.edges().filter_by(GeomType.CIRCLE):
            if e.radius is not None and abs(e.radius - sen["holeDiaMm"] / 2) < 0.05:
                c0 = e.arc_center
                cy, cz = round(c0.Y, 3), round(c0.Z, 3)
                if abs(c0.X - bx) < WALL and not any(abs(cy - y) < 0.05 and abs(cz - z) < 0.05 for y, z in sensor_holes):
                    sensor_holes.append((cy, cz))
    mounts = {"standoffHoles": [h for d in pilots for h in centres(d / 2)], "casterHoles": centres(c["holeDiaMm"] / 2), "sensorHoles": [{"yMm": y, "zMm": z} for y, z in sensor_holes]}
    bracket_holes = []
    for m in spec["motors"]:
        mount = m.get("mount", {})
        if mount.get("kind") == "bracket":
            for h in centres(mount["holeDiaMm"] / 2):
                if not any(abs(h["xMm"] - b["xMm"]) < 0.05 and abs(h["yMm"] - b["yMm"]) < 0.05 for b in bracket_holes):
                    bracket_holes.append(h)
    mounts["motorBracketHoles"] = bracket_holes
    mounts["clampScrews"] = clamp_screws
    return part, mounts


def main():
    if len(sys.argv) != 3:
        print("usage: chassis.py <spec.json> <out-dir>", file=sys.stderr)
        sys.exit(2)
    spec = json.loads(Path(sys.argv[1]).read_text())
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    try:
        part, mounts = build(spec)
    except ChassisError as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
    export_step(part, str(out / "chassis.step"))
    export_stl(part, str(out / "chassis.stl"))
    # The motor clamp (one per clamped motor, all alike): a bar under the motor across the cradle and its bosses, a
    # clearance hole for each M2 screw.
    clamped = [m for m in spec["motors"] if m.get("mount", {}).get("kind") == "clamp"]
    if clamped:
        mount = clamped[0]["mount"]
        cl, cw, ct = mount["clampMm"]
        span = abs(mount["screwHoles"][1]["xMm"] - mount["screwHoles"][0]["xMm"])
        clamp = Box(cl, cw, ct)
        for s in (-1, 1):
            clamp -= Pos(s * span / 2, 0, 0) * Cylinder(1.1, ct + 2)
        export_stl(clamp, str(out / "motor-clamp.stl"))
    (out / "mounts.json").write_text(json.dumps(mounts, indent=1))


if __name__ == "__main__":
    main()
