"""Open-top enclosure built from the design contract.

usage: enclosure.py <spec.json> <outdir>

spec = {outline: {widthMm, heightMm, thicknessMm}, connectors: [Connector], wallMm, clearanceMm, heightMm}

Frame: the board's bottom-left corner is the origin, X runs along widthMm, Y along heightMm, and the board rests on
the floor (its bottom face at z = wallMm). Every cutout is placed from contract coordinates; nothing is subtracted
from a board mesh. cutouts.json is measured back from the finished solid, so it reports the holes that exist rather
than echoing the spec.
"""

import json
import sys
from pathlib import Path

from build123d import Box, Pos, export_step, export_stl

SLOT_MARGIN_MM = 0.5  # each way around the connector
EDGES = ("left", "right", "top", "bottom")


def fail(msg):
    print(f"enclosure: {msg}", file=sys.stderr)
    sys.exit(2)


def load(path):
    try:
        spec = json.loads(Path(path).read_text())
        o = spec["outline"]
        w, h, t = float(o["widthMm"]), float(o["heightMm"]), float(o["thicknessMm"])
        wall, clear, height = float(spec["wallMm"]), float(spec["clearanceMm"]), float(spec["heightMm"])
        conns = spec["connectors"]
    except (OSError, ValueError, KeyError, TypeError) as e:
        fail(f"bad spec {path}: {e!r}")
    if min(w, h, t, wall, height) <= 0 or clear < 0:
        fail(f"outline, wall and height must be positive: {spec}")
    return w, h, t, wall, clear, height, conns


def edge_length(edge, w, h):
    return h if edge in ("left", "right") else w


def slot(conn, w, h, t, wall, clear, height):
    """Box that pierces the wall on the connector's edge, centred on the connector."""
    ref, edge = conn.get("ref", "?"), conn.get("edge")
    if edge not in EDGES:
        fail(f"{ref}: edge must be one of {EDGES}, got {edge!r}")
    off, cw, ch = float(conn["offsetMm"]), float(conn["widthMm"]), float(conn["heightMm"])
    along, up = cw + 2 * SLOT_MARGIN_MM, ch + 2 * SLOT_MARGIN_MM
    length = edge_length(edge, w, h)
    if not 0 <= off <= length:
        fail(f"{ref}: offset {off} mm is off the {edge} edge (0..{length} mm)")
    if off - along / 2 < -clear or off + along / 2 > length + clear:
        fail(f"{ref}: {along} mm cutout at {off} mm does not fit inside the {edge} wall")
    zc = wall + t + ch / 2
    if zc + up / 2 > height:
        fail(f"{ref}: cutout top {zc + up / 2:.2f} mm is above the {height} mm wall")
    depth = 3 * wall
    mid = clear + wall / 2  # wall centre, measured outward from the board edge
    if edge == "left":
        return Pos(-mid, off, zc) * Box(depth, along, up)
    if edge == "right":
        return Pos(w + mid, off, zc) * Box(depth, along, up)
    if edge == "bottom":
        return Pos(off, -mid, zc) * Box(along, depth, up)
    return Pos(off, h + mid, zc) * Box(along, depth, up)


def measure(hole, edge):
    """Read a cutout back from the material it removed, in the Connector frame."""
    bb = hole.bounding_box()
    if edge in ("left", "right"):
        return (bb.min.Y + bb.max.Y) / 2, bb.size.Y, bb.size.Z
    return (bb.min.X + bb.max.X) / 2, bb.size.X, bb.size.Z


def main():
    if len(sys.argv) != 3:
        fail("usage: enclosure.py <spec.json> <outdir>")
    w, h, t, wall, clear, height, conns = load(sys.argv[1])
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)

    iw, ih = w + 2 * clear, h + 2 * clear
    cx, cy = w / 2, h / 2
    outer = Pos(cx, cy, height / 2) * Box(iw + 2 * wall, ih + 2 * wall, height)
    cavity = Pos(cx, cy, wall + height / 2) * Box(iw, ih, height)
    blank = outer - cavity

    case, cutouts = blank, []
    for conn in conns:
        s = slot(conn, w, h, t, wall, clear, height)
        hole = blank & s
        if hole.volume <= 0:
            fail(f"{conn['ref']}: cutout does not reach the {conn['edge']} wall")
        off, along, up = measure(hole, conn["edge"])
        cutouts.append({"ref": conn["ref"], "edge": conn["edge"], "offsetMm": round(off, 3), "widthMm": round(along, 3), "heightMm": round(up, 3)})
        case = case - s

    removed = blank.volume - case.volume
    expected = sum(c["widthMm"] * c["heightMm"] * wall for c in cutouts)
    if abs(removed - expected) > 0.01 * max(expected, 1):
        fail(f"cutouts removed {removed:.1f} mm3, expected {expected:.1f} mm3 (overlapping slots?)")

    export_step(case, str(out / "case.step"))
    export_stl(case, str(out / "case.stl"))
    (out / "cutouts.json").write_text(json.dumps(cutouts, indent=2) + "\n")
    print(f"case {iw + 2 * wall:.1f}x{ih + 2 * wall:.1f}x{height:.1f} mm, {len(cutouts)} cutouts, volume {case.volume:.0f} mm3")


if __name__ == "__main__":
    main()
