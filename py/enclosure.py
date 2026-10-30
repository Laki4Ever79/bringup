"""Print-ready enclosure built from the design contract: a case with standoffs, and a lid.

usage: enclosure.py <spec.json> <outdir>

spec = {outline: {widthMm, heightMm, thicknessMm}, connectors: [Connector], holes: [{ref, xMm, yMm}],
        wallMm, clearanceMm, heightMm, standoff: {heightMm, outerMm, pilotMm},
        lid: {plateMm, lipMm, lipWallMm, clearanceMm}}

Frame: the board's bottom-left corner is the origin, X runs along widthMm, Y along heightMm, and the floor's underside
is z = 0. The board's underside rests on the standoffs at z = wallMm + standoff.heightMm. Every cutout and post is
placed from contract coordinates; nothing is subtracted from a board mesh. cutouts.json and standoffs.json are measured
back from the finished solid, so they report what exists rather than echoing the spec.

Outputs: case.step/.stl (printed open side up, as built), lid.step/.stl (printed plate down: z mirrored, so
z_assembled = heightMm + lid.plateMm - z), cutouts.json, standoffs.json, print.json.
"""

import json
import struct
import sys
from collections import Counter
from pathlib import Path

from build123d import Box, Cylinder, Plane, Pos, export_step, export_stl, mirror

SLOT_MARGIN_MM = 0.5  # each way around the connector
EDGES = ("left", "right", "top", "bottom")
MIN_WALL_MM = 1.2  # three 0.4 mm perimeters
MAX_BRIDGE_MM = 12.0  # PLA/PETG bridge this far cleanly at 0.2 mm layers with part cooling
OVERHANG_COS = 0.7071  # a face pointing down more than 45 degrees from vertical needs support
LID_CLEARANCE_MM = (0.2, 0.3)


def fail(msg):
    print(f"enclosure: {msg}", file=sys.stderr)
    sys.exit(2)


def load(path):
    try:
        spec = json.loads(Path(path).read_text())
        o = spec["outline"]
        dims = {
            "w": float(o["widthMm"]), "h": float(o["heightMm"]), "t": float(o["thicknessMm"]),
            "wall": float(spec["wallMm"]), "clear": float(spec["clearanceMm"]), "height": float(spec["heightMm"]),
            "post_h": float(spec["standoff"]["heightMm"]), "post_od": float(spec["standoff"]["outerMm"]),
            "pilot": float(spec["standoff"]["pilotMm"]),
            "plate": float(spec["lid"]["plateMm"]), "lip": float(spec["lid"]["lipMm"]),
            "lip_wall": float(spec["lid"]["lipWallMm"]), "lid_clear": float(spec["lid"]["clearanceMm"]),
        }
        conns, holes = spec["connectors"], spec.get("holes", [])
    except (OSError, ValueError, KeyError, TypeError) as e:
        fail(f"bad spec {path}: {e!r}")
    if min(dims["w"], dims["h"], dims["t"], dims["wall"], dims["height"], dims["post_od"], dims["plate"]) <= 0 or dims["clear"] < 0:
        fail(f"outline, wall and height must be positive: {spec}")
    if dims["pilot"] >= dims["post_od"]:
        fail(f"pilot hole {dims['pilot']} mm does not fit in a {dims['post_od']} mm post")
    return dims, conns, holes


def board_z(d):
    """Height of the board's underside: the floor plus the standoffs."""
    return d["wall"] + d["post_h"]


def slot_extent(conn, d):
    """(offset, along, up, zc, wall length) of a connector's cutout, checked against the wall it pierces."""
    ref, edge = conn.get("ref", "?"), conn.get("edge")
    if edge not in EDGES:
        fail(f"{ref}: edge must be one of {EDGES}, got {edge!r}")
    off, cw, ch = float(conn["offsetMm"]), float(conn["widthMm"]), float(conn["heightMm"])
    along, up = cw + 2 * SLOT_MARGIN_MM, ch + 2 * SLOT_MARGIN_MM
    length = d["h"] if edge in ("left", "right") else d["w"]
    if not 0 <= off <= length:
        fail(f"{ref}: offset {off} mm is off the {edge} edge (0..{length} mm)")
    if off - along / 2 < -d["clear"] or off + along / 2 > length + d["clear"]:
        fail(f"{ref}: {along} mm cutout at {off} mm does not fit inside the {edge} wall")
    zc = board_z(d) + d["t"] + ch / 2
    # The lid's lip lines the top of the walls from inside; a cutout reaching into it would be covered.
    if zc + up / 2 > d["height"] - d["lip"]:
        fail(f"{ref}: cutout top {zc + up / 2:.2f} mm reaches the lid's lip (starts at {d['height'] - d['lip']:.2f} mm)")
    return off, along, up, zc, length


def slot(conn, d):
    """Box that pierces the wall on the connector's edge, centred on the connector."""
    off, along, up, zc, _ = slot_extent(conn, d)
    depth = 3 * d["wall"]
    mid = d["clear"] + d["wall"] / 2  # wall centre, measured outward from the board edge
    edge = conn["edge"]
    if edge == "left":
        return Pos(-mid, off, zc) * Box(depth, along, up)
    if edge == "right":
        return Pos(d["w"] + mid, off, zc) * Box(depth, along, up)
    if edge == "bottom":
        return Pos(off, -mid, zc) * Box(along, depth, up)
    return Pos(off, d["h"] + mid, zc) * Box(along, depth, up)


def measure(hole, edge):
    """Read a cutout back from the material it removed, in the Connector frame, plus its centre height."""
    bb = hole.bounding_box()
    zc = (bb.min.Z + bb.max.Z) / 2
    if edge in ("left", "right"):
        return (bb.min.Y + bb.max.Y) / 2, bb.size.Y, bb.size.Z, zc
    return (bb.min.X + bb.max.X) / 2, bb.size.X, bb.size.Z, zc


def build_case(d, holes):
    iw, ih = d["w"] + 2 * d["clear"], d["h"] + 2 * d["clear"]
    cx, cy = d["w"] / 2, d["h"] / 2
    outer = Pos(cx, cy, d["height"] / 2) * Box(iw + 2 * d["wall"], ih + 2 * d["wall"], d["height"])
    cavity = Pos(cx, cy, d["wall"] + d["height"] / 2) * Box(iw, ih, d["height"])
    blank = outer - cavity
    # Posts stand on the floor; each pilot hole goes 1 mm into the floor so an M2x6 screw bites ~4 mm of plastic.
    pilot_depth = d["post_h"] + min(1.0, d["wall"] / 2)
    for h in holes:
        x, y = float(h["xMm"]), float(h["yMm"])
        blank = blank + Pos(x, y, d["wall"] + d["post_h"] / 2) * Cylinder(d["post_od"] / 2, d["post_h"])
        blank = blank - Pos(x, y, board_z(d) - pilot_depth / 2) * Cylinder(d["pilot"] / 2, pilot_depth)
    return blank, iw, ih


def build_lid(d, iw, ih):
    """Assembled pose: the plate sits on the walls' top, the lip hangs down inside them."""
    cx, cy = d["w"] / 2, d["h"] / 2
    plate = Pos(cx, cy, d["height"] + d["plate"] / 2) * Box(iw + 2 * d["wall"], ih + 2 * d["wall"], d["plate"])
    lw, lh = iw - 2 * d["lid_clear"], ih - 2 * d["lid_clear"]
    lip_outer = Pos(cx, cy, d["height"] - d["lip"] / 2) * Box(lw, lh, d["lip"])
    lip_inner = Pos(cx, cy, d["height"] - d["lip"] / 2) * Box(lw - 2 * d["lip_wall"], lh - 2 * d["lip_wall"], d["lip"])
    return plate + (lip_outer - lip_inner)


def measure_standoffs(case, d, holes):
    """Each post's centre and pilot diameter, read from the solid around the spec position."""
    out = []
    for h in holes:
        x, y = float(h["xMm"]), float(h["yMm"])
        zc, tall = d["wall"] + d["post_h"] / 2, d["post_h"] * 0.98
        post = case & (Pos(x, y, zc) * Cylinder(d["post_od"] / 2 + 0.5, tall))
        if post.volume <= 0:
            fail(f"{h.get('ref', '?')}: no standoff was built at ({x}, {y}) mm")
        bb = post.bounding_box()
        bore = (Pos(x, y, zc) * Cylinder(d["post_od"] / 2 - 0.01, tall)) - case
        out.append({
            "ref": h.get("ref"),
            "xMm": round((bb.min.X + bb.max.X) / 2, 3),
            "yMm": round((bb.min.Y + bb.max.Y) / 2, 3),
            "holeMm": round(bore.bounding_box().size.X, 3) if bore.volume > 0 else 0.0,
        })
    return out


# ---- print check ----------------------------------------------------------------------------------------------

def stl_manifold_issues(path, name):
    """A watertight, consistently oriented mesh: every edge is used once in each direction (binary STL)."""
    data = Path(path).read_bytes()
    (count,) = struct.unpack_from("<I", data, 80)
    key = lambda v: tuple(round(c, 4) for c in v)  # noqa: E731
    directed = Counter()
    for i in range(count):
        vals = struct.unpack_from("<12f", data, 84 + 50 * i)
        a, b, c = key(vals[3:6]), key(vals[6:9]), key(vals[9:12])
        if a == b or b == c or a == c:
            continue  # degenerate sliver from tessellation
        for e in ((a, b), (b, c), (c, a)):
            directed[e] += 1
    bad = sum(1 for (u, v), n in directed.items() if n != 1 or directed.get((v, u)) != 1)
    return [f"{name}: mesh is not watertight ({bad} open or doubled edges)"] if bad else []


def overhang_issues(solid, name, slots):
    """Faces off the bed that point down more than 45 degrees. Flat ceilings are bridges: a cutout's ceiling spans
    its width along the wall; any other flat ceiling its shorter side."""
    issues = []
    for face in solid.faces():
        bb = face.bounding_box()
        if bb.min.Z < 1e-3:
            continue  # on the bed
        try:
            n = face.normal_at(face.center())
        except Exception:
            continue  # not a surface we can orient (none in this design)
        if n.Z > -OVERHANG_COS:
            continue
        if n.Z < -0.999:
            c = face.center()
            ref = next((r for r, s in slots if _over(s.bounding_box(), c)), None)
            span = max(bb.size.X, bb.size.Y) if ref else min(bb.size.X, bb.size.Y)
            if span > MAX_BRIDGE_MM:
                where = f"{ref}: " if ref else ""
                issues.append(f"{name}: {where}{span:.1f} mm bridge at z {bb.min.Z:.1f} mm (max {MAX_BRIDGE_MM:.0f} mm without support)")
        else:
            issues.append(f"{name}: overhang steeper than 45 degrees at z {bb.min.Z:.1f} mm, {bb.size.X:.1f}x{bb.size.Y:.1f} mm")
    return issues


def _over(box, point):
    """Whether point is on the ceiling of a slot box."""
    e = 1e-6
    return box.min.X - e <= point.X <= box.max.X + e and box.min.Y - e <= point.Y <= box.max.Y + e and abs(box.max.Z - point.Z) < 1e-3


def thin_wall_issues(d, conns):
    """The thinnest printed features, from the design's dimensions."""
    features = {
        "wall": d["wall"], "floor": d["wall"], "lid plate": d["plate"], "lid lip": d["lip_wall"],
        "standoff ring": (d["post_od"] - d["pilot"]) / 2,
    }
    by_edge = {}
    for c in conns:
        off, along, up, zc, length = slot_extent(c, d)
        features[f"{c['ref']}: wall above the cutout"] = d["height"] - (zc + up / 2)
        features[f"{c['ref']}: wall beside the cutout"] = min(off - along / 2 + d["clear"], length + d["clear"] - (off + along / 2))
        by_edge.setdefault(c["edge"], []).append((off - along / 2, off + along / 2, c["ref"]))
    for spans in by_edge.values():
        spans.sort()
        for (_, end, a), (start, _, b) in zip(spans, spans[1:]):
            features[f"{a}/{b}: wall between the cutouts"] = start - end
    issues = [f"{k} {v:g} mm < {MIN_WALL_MM} mm" for k, v in features.items() if v < MIN_WALL_MM - 1e-9]
    return issues, min(features.values())


def lid_fit(case, lid, d):
    """Clearance per side between the lip and the case's inner wall, measured from the two solids."""
    cx, cy, z = d["w"] / 2, d["h"] / 2, d["height"] - d["lip"] / 2
    outer_w, outer_h = d["w"] + 2 * d["clear"] + 2 * d["wall"], d["h"] + 2 * d["clear"] + 2 * d["wall"]
    probe = Pos(cx, cy, z) * Box(outer_w - 0.01, outer_h - 0.01, 0.2)  # a thin slice inside the outer walls
    cavity = (probe - case).bounding_box()
    lip = (lid & probe).bounding_box()
    return min((cavity.size.X - lip.size.X) / 2, (cavity.size.Y - lip.size.Y) / 2)


def main():
    if len(sys.argv) != 3:
        fail("usage: enclosure.py <spec.json> <outdir>")
    d, conns, holes = load(sys.argv[1])
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)

    blank, iw, ih = build_case(d, holes)
    case, cutouts, slots = blank, [], []
    for conn in conns:
        s = slot(conn, d)
        hole = blank & s
        if hole.volume <= 0:
            fail(f"{conn['ref']}: cutout does not reach the {conn['edge']} wall")
        off, along, up, zc = measure(hole, conn["edge"])
        cutouts.append({"ref": conn["ref"], "edge": conn["edge"], "offsetMm": round(off, 3), "widthMm": round(along, 3), "heightMm": round(up, 3), "zMm": round(zc, 3)})
        slots.append((conn["ref"], s))
        case = case - s

    removed = blank.volume - case.volume
    expected = sum(c["widthMm"] * c["heightMm"] * d["wall"] for c in cutouts)
    if abs(removed - expected) > 0.01 * max(expected, 1):
        fail(f"cutouts removed {removed:.1f} mm3, expected {expected:.1f} mm3 (overlapping slots?)")

    lid = build_lid(d, iw, ih)
    # Printed plate down: mirror through z = 0, then lift the plate onto the bed.
    lid_print = Pos(0, 0, d["height"] + d["plate"]) * mirror(lid, Plane.XY)
    standoffs = measure_standoffs(case, d, holes)

    export_step(case, str(out / "case.step"))
    export_stl(case, str(out / "case.stl"))
    export_step(lid_print, str(out / "lid.step"))
    export_stl(lid_print, str(out / "lid.stl"))

    issues, min_wall = thin_wall_issues(d, conns)
    for name, solid in (("case", case), ("lid", lid_print)):
        if not solid.is_valid:
            issues.append(f"{name}: the solid is not valid")
    issues += stl_manifold_issues(out / "case.stl", "case") + stl_manifold_issues(out / "lid.stl", "lid")
    issues += overhang_issues(case, "case", slots) + overhang_issues(lid_print, "lid", [])
    clearance = lid_fit(case, lid, d)
    lo, hi = LID_CLEARANCE_MM
    if not lo - 1e-3 <= clearance <= hi + 1e-3:
        issues.append(f"lid clearance {clearance:.2f} mm per side (needs {lo}-{hi} mm)")
    check = {"ok": not issues, "issues": issues, "minWallMm": round(min_wall, 3), "lidClearanceMm": round(clearance, 3)}

    (out / "cutouts.json").write_text(json.dumps(cutouts, indent=2) + "\n")
    (out / "standoffs.json").write_text(json.dumps(standoffs, indent=2) + "\n")
    (out / "print.json").write_text(json.dumps(check, indent=2) + "\n")
    verdict = "print check ok" if check["ok"] else f"print check: {len(issues)} issue(s)"
    print(f"case {iw + 2 * d['wall']:.1f}x{ih + 2 * d['wall']:.1f}x{d['height']:.1f} mm + {d['plate']:.1f} mm lid, "
          f"{len(cutouts)} cutouts, {len(standoffs)} standoffs; {verdict}")


if __name__ == "__main__":
    main()
