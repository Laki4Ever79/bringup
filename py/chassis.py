"""A rover's 3D-printable chassis from its mechanics contract (docs/mechanics.md).

Usage: chassis.py <spec.json> <out-dir>  →  chassis.step, chassis.stl, mounts.json

The spec (src/tools/chassis.ts chassisSpec) is in the chassis frame: origin at the plate's centre, +x forward, +y left,
millimetres. Here z = 0 is the plate's underside (the rover's clearance is added by whoever places it). The part:
the plate; under it, a cradle per motor and the caster's four bolt holes; on it, two rails that keep the battery in
place, a standoff with an M2.5 hole at each board corner, and an upright bracket the distance sensor's breakout screws
to at the front. mounts.json lists the hole centres measured back from the built solid, so the board and caster are
checked against what was really made.
"""

import json
import sys
from pathlib import Path

from build123d import Box, Cylinder, GeomType, Pos, export_step, export_stl

STANDOFF_OD = 5.0
M25_HOLE = 2.7  # an M2.5 screw's clearance hole
WALL = 2.0
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

    # Standoffs at each board's corners, with an M2.5 hole through standoff and plate.
    holes = []
    for b in spec["boards"]:
        for x, y in _board_holes(b):
            part += Pos(x, y, t + so / 2) * Cylinder(STANDOFF_OD / 2, so)
            holes.append((x, y))
    for x, y in holes:
        part -= Pos(x, y, (t + so) / 2) * Cylinder(M25_HOLE / 2, t + so + 2)

    # The caster's bolt holes.
    c = spec["caster"]
    for dx, dy in c["holesMm"]:
        part -= Pos(c["xMm"] + dx, dy, t / 2) * Cylinder(c["holeDiaMm"] / 2, t + 2)

    # A cradle under the plate per motor, down to the axle (axleDropMm under the plate): a block around the body with
    # the body cut out, axis along y.
    for m in spec["motors"]:
        L, W, H = m["bodyMm"]
        drop = max(m.get("axleDropMm", H / 2 + WALL), H / 2 + WALL)
        depth = drop + H / 2 + WALL
        block = Pos(m["xMm"], m["yMm"], -depth / 2) * Box(W + 2 * WALL, L, depth)
        body = Pos(m["xMm"], m["yMm"], -drop) * Box(W, L + 2, H)
        part += block - body

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
    part += Pos(sen["xMm"] - sd / 2 - WALL / 2, sen["yMm"], t + height / 2) * Box(WALL, sw + 2 * WALL, height)

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

    mounts = {"standoffHoles": centres(M25_HOLE / 2), "casterHoles": centres(c["holeDiaMm"] / 2)}
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
    (out / "mounts.json").write_text(json.dumps(mounts, indent=1))


if __name__ == "__main__":
    main()
