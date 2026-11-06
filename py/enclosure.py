"""Print-ready enclosure built from the design contract: a case with standoffs, and a lid.

usage: enclosure.py <spec.json> <outdir>

spec = {outline: {widthMm, heightMm, thicknessMm}, connectors: [Connector], holes: [{ref, xMm, yMm}], sensors: [{ref, xMm, yMm}],
        wallMm, clearanceMm, heightMm, standoff: {heightMm, outerMm, pilotMm},
        lid: {plateMm, lipMm, lipWallMm, clearanceMm},
        features: [CaseFeature] (optional: wall-mount, lanyard, text, hole; src/contract/types.ts),
        featureGeometry: {mountTab, lanyardTab: {outMm, alongMm, thickMm, holeMm}, text: {depthMm, minMm, maxMm}, holeZMm}}

Frame: the board's bottom-left corner is the origin, X runs along widthMm, Y along heightMm, and the floor's underside
is z = 0. The board's underside rests on the standoffs at z = wallMm + standoff.heightMm. Every cutout and post is
placed from contract coordinates; nothing is subtracted from a board mesh. cutouts.json and standoffs.json are measured
back from the finished solid, so they report what exists rather than echoing the spec.

Outputs: case.step/.stl (printed open side up, as built), lid.step/.stl (printed plate down: z mirrored, so
z_assembled = heightMm + lid.plateMm - z), cutouts.json, standoffs.json, vents.json, features.json, print.json.
A feature that can't be built is reported in features.json (ok false, with the reason) rather than failing the build.
"""

import json
import struct
import sys
from collections import Counter
from pathlib import Path

from build123d import Box, Cylinder, Plane, Pos, Rot, Text, export_step, export_stl, extrude, mirror

SLOT_MARGIN_MM = 0.5  # each way around the connector
EDGES = ("left", "right", "top", "bottom")
MIN_WALL_MM = 1.2  # three 0.4 mm perimeters
MAX_BRIDGE_MM = 12.0  # PLA/PETG bridge this far cleanly at 0.2 mm layers with part cooling
OVERHANG_COS = 0.5 ** 0.5  # cos 45°: a face pointing down more than 45 degrees from vertical needs support
LID_CLEARANCE_MM = (0.2, 0.3)
# A slot grille through the lid over each temperature/humidity sensor. Sensirion's design guide for its humidity and
# temperature sensors (HT_AN_SHTxx_STSxx Design Guide v1.1, May 2019, the one the SHT4x documents point to): give the
# sensor a large opening to the environment, keep the dead volume around it small, and keep it away from heat sources
# (the board generator already puts the sensor in the corner farthest from the MCU and the LDO). Slots, not one round
# hole, so a finger can't reach the board; 1.2 mm is three perimeters wide and prints cleanly through a 2 mm plate.
VENT = {"slots": 4, "slotMm": 1.2, "pitchMm": 2.4, "lengthMm": 6.0}

# A round opening through the floor under each bottom-port microphone's sound hole (ICS-43434: the port faces the PCB,
# which has a hole under it, so sound comes from below the board). 2 mm: well over the 0.6 mm PCB hole, and it prints
# as a clean round hole through the 2 mm floor. A first acoustic path, not a sealed gasket.
PORT_MM = 2.0


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
        conns, holes, sensors = spec["connectors"], spec.get("holes", []), spec.get("sensors", [])
        d_ports = spec.get("ports", [])
    except (OSError, ValueError, KeyError, TypeError) as e:
        fail(f"bad spec {path}: {e!r}")
    if min(dims["w"], dims["h"], dims["t"], dims["wall"], dims["height"], dims["post_od"], dims["plate"]) <= 0 or dims["clear"] < 0:
        fail(f"outline, wall and height must be positive: {spec}")
    if dims["pilot"] >= dims["post_od"]:
        fail(f"pilot hole {dims['pilot']} mm does not fit in a {dims['post_od']} mm post")
    dims["ports"] = d_ports
    dims["features"] = spec.get("features", [])
    dims["fg"] = spec.get("featureGeometry")
    dims["shift"] = spec.get("frameShiftMm", [0, 0])
    dims["antenna"] = spec.get("antenna")
    if dims["features"] and not dims["fg"]:
        fail("features need featureGeometry")
    return dims, conns, holes, sensors


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


def vent_cut(sensor, d):
    """The grille's slots over one sensor, through the lid's plate, kept inside the lip so it never cuts it."""
    n, slot, pitch, length = VENT["slots"], VENT["slotMm"], VENT["pitchMm"], VENT["lengthMm"]
    span = (n - 1) * pitch + slot
    inner = d["clear"] - d["lid_clear"] - d["lip_wall"] - 0.5  # the lip's inner face, from the board edge, with margin
    x = min(max(float(sensor["xMm"]), span / 2 - inner), d["w"] + inner - span / 2)
    y = min(max(float(sensor["yMm"]), length / 2 - inner), d["h"] + inner - length / 2)
    z = d["height"] + d["plate"] / 2
    cut = None
    for i in range(n):
        box = Pos(x - span / 2 + slot / 2 + i * pitch, y, z) * Box(slot, length, d["plate"] * 1.5)
        cut = box if cut is None else cut + box
    return cut


def measure_ports(case, d):
    """Each floor opening's centre and diameter, read back from the open area in the built case's floor."""
    out = []
    for port in d["ports"]:
        x, y = float(port["xMm"]), float(port["yMm"])
        region = Pos(x, y, d["wall"] / 2) * Box(PORT_MM + 4, PORT_MM + 4, d["wall"] * 0.98)
        opening = region - case
        if opening.volume <= 0:
            fail(f"{port.get('ref', '?')}: no opening was cut under the microphone at ({x}, {y}) mm")
        bb = opening.bounding_box()
        out.append({"ref": port.get("ref"), "xMm": round((bb.min.X + bb.max.X) / 2, 3), "yMm": round((bb.min.Y + bb.max.Y) / 2, 3), "diameterMm": round(bb.size.X, 3)})
    return out


def measure_vents(lid, d, sensors):
    """Each grille's centre and size, read back from the open area in the built lid's plate."""
    out = []
    span = (VENT["slots"] - 1) * VENT["pitchMm"] + VENT["slotMm"]
    for sensor in sensors:
        x, y = float(sensor["xMm"]), float(sensor["yMm"])
        z = d["height"] + d["plate"] / 2
        # Only inside the lip: beyond the plate's edge there is air too, and it isn't a vent.
        inner_w = d["w"] + 2 * (d["clear"] - d["lid_clear"] - d["lip_wall"])
        inner_h = d["h"] + 2 * (d["clear"] - d["lid_clear"] - d["lip_wall"])
        inside = Pos(d["w"] / 2, d["h"] / 2, z) * Box(inner_w, inner_h, d["plate"] * 0.98)
        region = inside & (Pos(x, y, z) * Box(span + 4, VENT["lengthMm"] + 4, d["plate"] * 0.98))
        opening = region - lid
        if opening.volume <= 0:
            fail(f"{sensor.get('ref', '?')}: no vent was cut over the sensor at ({x}, {y}) mm")
        bb = opening.bounding_box()
        out.append({
            "ref": sensor.get("ref"),
            "xMm": round((bb.min.X + bb.max.X) / 2, 3),
            "yMm": round((bb.min.Y + bb.max.Y) / 2, 3),
            "widthMm": round(bb.size.X, 3),
            "heightMm": round(bb.size.Y, 3),
            "openMm2": round(opening.volume / (d["plate"] * 0.98), 2),
        })
    return out


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


# ---- added features (the case field) --------------------------------------------------------------------------

def _wall_frame(edge, d):
    """(x, y) of a point on the wall's centre plane, as a function of the offset along the edge, and the axis through it."""
    mid = d["clear"] + d["wall"] / 2
    if edge == "left":
        return (lambda off: (-mid, off)), "x"
    if edge == "right":
        return (lambda off: (d["w"] + mid, off)), "x"
    if edge == "bottom":
        return (lambda off: (off, -mid)), "y"
    return (lambda off: (off, d["h"] + mid)), "y"


def teardrop(edge, off, dia, d):
    """A round hole through a wall with a 45-degree roof: prints without support, the usual shape for a horizontal
    hole. The roof is a square with one corner at the centre, so its sides meet the circle where it turns 45 degrees."""
    at, axis = _wall_frame(edge, d)
    x, y = at(off)
    z = d["fg"]["holeZMm"]
    r, depth = dia / 2, 3 * d["wall"]
    if axis == "x":
        bore = Pos(x, y, z) * Rot(0, 90, 0) * Cylinder(r, depth)
        roof = Pos(x, y, z + r / 2 ** 0.5) * Rot(45, 0, 0) * Box(depth, r, r)
    else:
        bore = Pos(x, y, z) * Rot(90, 0, 0) * Cylinder(r, depth)
        roof = Pos(x, y, z + r / 2 ** 0.5) * Rot(0, 45, 0) * Box(r, depth, r)
    return bore + roof


def tab(wall, centre, t, d):
    """A flat tab flush with the floor, outside a wall, with a vertical hole: (solid, hole cylinder, hole centre)."""
    side = d["clear"] + d["wall"]
    out, along, thick, hole = t["outMm"], t["alongMm"], t["thickMm"], t["holeMm"]
    if wall == "left":
        cx, cy, sx, sy = -side - out / 2, centre, out, along
    elif wall == "right":
        cx, cy, sx, sy = d["w"] + side + out / 2, centre, out, along
    elif wall == "bottom":
        cx, cy, sx, sy = centre, -side - out / 2, along, out
    else:
        cx, cy, sx, sy = centre, d["h"] + side + out / 2, along, out
    # Overlap the wall by 0.5 mm so the tab fuses into it.
    grow = 0.5
    if wall in ("left", "right"):
        body = Pos(cx + (grow / 2 if wall == "left" else -grow / 2), cy, thick / 2) * Box(sx + grow, sy, thick)
    else:
        body = Pos(cx, cy + (grow / 2 if wall == "bottom" else -grow / 2), thick / 2) * Box(sx, sy + grow, thick)
    return body, Pos(cx, cy, thick / 2) * Cylinder(hole / 2, thick * 3), (cx, cy)


def tab_centres(f, d):
    """[(wall, centre along the wall in the contract frame, tab geometry)] for a wall-mount or a lanyard feature."""
    side = d["clear"] + d["wall"]
    if f["kind"] == "wall-mount":
        t = d["fg"]["mountTab"]
        walls = ("left", "right") if f["sides"] == "left-right" else ("top", "bottom")
        return [(w, (d["h"] if w in ("left", "right") else d["w"]) / 2, t) for w in walls]
    t = d["fg"]["lanyardTab"]
    wall = "left" if f["corner"].endswith("left") else "right"
    top = f["corner"].startswith("top")
    return [(wall, d["h"] + side - t["alongMm"] / 2 if top else -side + t["alongMm"] / 2, t)]


def open_centre(region, solid):
    """Centre and width of the open space inside region (a box around a hole), or None when it is closed."""
    opening = region - solid
    if opening.volume <= 1e-6:
        return None
    bb = opening.bounding_box()
    return (bb.min.X + bb.max.X) / 2, (bb.min.Y + bb.max.Y) / 2, (bb.min.Z + bb.max.Z) / 2, bb.size


def add_case_features(case, d):
    """Tabs, loops and wall holes on the case; each measured back from the solid. Returns (case, reports, tab bodies)."""
    reports = []
    for f in d["features"]:
        kind = f.get("kind")
        if kind in ("wall-mount", "lanyard"):
            holes = []
            for wall, centre, t in tab_centres(f, d):
                body, bore, (cx, cy) = tab(wall, centre, t, d)
                case = case + body - bore
                holes.append((cx, cy, t))
            measured = []
            for cx, cy, t in holes:
                got = open_centre(Pos(cx, cy, t["thickMm"] / 2) * Box(t["holeMm"] + 1, t["holeMm"] + 1, t["thickMm"] * 0.98), case)
                measured.append(got)
            if any(m is None for m in measured):
                reports.append({"id": f["id"], "kind": kind, "ok": False, "issue": "a tab's screw hole is closed"})
                continue
            x, y, _, size = measured[0]
            reports.append({"id": f["id"], "kind": kind, "ok": True, "xMm": round(x, 3), "yMm": round(y, 3), "diameterMm": round(size.X, 3), "tabs": len(measured)})
        elif kind == "hole":
            edge, off, dia = f["edge"], float(f["offsetMm"]), float(f["diameterMm"])
            case = case - teardrop(edge, off, dia, d)
            at, axis = _wall_frame(edge, d)
            x, y = at(off)
            z = d["fg"]["holeZMm"]
            # Just around the teardrop (its tip is r*sqrt(2) above the centre), so a neighbouring cutout or the air
            # above the wall never counts as this hole.
            r = dia / 2
            lo, hi = z - r - 0.3, z + r * 2 ** 0.5 + 0.3
            zc, zs = (lo + hi) / 2, hi - lo
            region = Pos(x, y, zc) * (Box(d["wall"] * 0.98, dia + 0.6, zs) if axis == "x" else Box(dia + 0.6, d["wall"] * 0.98, zs))
            got = open_centre(region, case)
            if got is None:
                reports.append({"id": f["id"], "kind": kind, "ok": False, "issue": f"no opening was cut through the {edge} wall"})
                continue
            cx, cy, _, size = got
            reports.append({"id": f["id"], "kind": kind, "ok": True, "edge": edge, "offsetMm": round(cy if axis == "x" else cx, 3), "zMm": round(z, 3), "diameterMm": round(size.Y if axis == "x" else size.X, 3)})
    return case, reports


def add_text(lid, d, vents):
    """Engraves the text feature into the lid's top (assembled pose), sized to fit and kept off the vents."""
    feats = [f for f in d["features"] if f.get("kind") == "text"]
    if not feats:
        return lid, []
    f, g = feats[0], d["fg"]["text"]
    top = d["height"] + d["plate"]
    plate_w, plate_h = d["w"] + 2 * (d["clear"] + d["wall"]), d["h"] + 2 * (d["clear"] + d["wall"])
    margin = 2.0
    size = g["maxMm"]
    glyphs = Text(f["text"], font_size=size)
    while glyphs.bounding_box().size.X > plate_w - 2 * margin and size > g["minMm"]:
        size = max(g["minMm"], size - 0.5)
        glyphs = Text(f["text"], font_size=size)
    bb = glyphs.bounding_box()
    if bb.size.X > plate_w - 2 * margin or bb.size.Y > plate_h - 2 * margin:
        return lid, [{"id": f["id"], "kind": "text", "ok": False, "issue": f"\"{f['text']}\" does not fit on the {plate_w:.0f} mm lid at {g['minMm']} mm letters"}]
    # Keep 1 mm of plate between the lettering and any vent: try the middle, then step away from it.
    def clear_of_vents(y):
        x0, x1 = d["w"] / 2 - bb.size.X / 2 - 1, d["w"] / 2 + bb.size.X / 2 + 1
        y0, y1 = y - bb.size.Y / 2 - 1, y + bb.size.Y / 2 + 1
        return all(x1 < v["xMm"] - v["widthMm"] / 2 or x0 > v["xMm"] + v["widthMm"] / 2 or y1 < v["yMm"] - v["heightMm"] / 2 or y0 > v["yMm"] + v["heightMm"] / 2 for v in vents)
    lo, hi = -d["clear"] - d["wall"] + margin + bb.size.Y / 2, d["h"] + d["clear"] + d["wall"] - margin - bb.size.Y / 2
    candidates = [d["h"] / 2 + s * k * 0.5 for k in range(0, int(plate_h * 2)) for s in (1, -1)]
    y = next((c for c in candidates if lo <= c <= hi and clear_of_vents(c)), None)
    if y is None:
        return lid, [{"id": f["id"], "kind": "text", "ok": False, "issue": "no room on the lid clear of the vents"}]
    # Centre the glyphs' own bounding box on (w/2, y): Text's origin is its alignment point, not the ink's centre.
    ox, oy = d["w"] / 2 - (bb.min.X + bb.max.X) / 2, y - (bb.min.Y + bb.max.Y) / 2
    cut = Pos(ox, oy, top - g["depthMm"]) * extrude(glyphs, amount=g["depthMm"] + 0.5)
    before = lid.volume
    lid = lid - cut
    removed = before - lid.volume
    if removed <= 1e-6:
        return lid, [{"id": f["id"], "kind": "text", "ok": False, "issue": "the engraving removed nothing"}]
    return lid, [{"id": f["id"], "kind": "text", "ok": True, "xMm": round(d["w"] / 2, 3), "yMm": round(y, 3), "textMm": size, "depthMm": g["depthMm"], "engravedMm3": round(removed, 2)}]


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
        if n.Z > -OVERHANG_COS - 1e-6:
            continue  # 45 degrees or less from vertical prints without support
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
    d, conns, holes, sensors = load(sys.argv[1])
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

    for port in d["ports"]:
        case = case - Pos(float(port["xMm"]), float(port["yMm"]), d["wall"] / 2) * Cylinder(PORT_MM / 2, d["wall"] * 3)
    ports = measure_ports(case, d)
    case, features = add_case_features(case, d)

    lid = build_lid(d, iw, ih)
    for sensor in sensors:
        lid = lid - vent_cut(sensor, d)
    vents = measure_vents(lid, d, sensors)
    lid, text = add_text(lid, d, vents)
    features += text
    # Printed plate down: mirror through z = 0, then lift the plate onto the bed.
    lid_print = Pos(0, 0, d["height"] + d["plate"]) * mirror(lid, Plane.XY)
    standoffs = measure_standoffs(case, d, holes)

    # Built in the case view's frame (the board plus the module's antenna); the files go out in the contract's frame,
    # the board's bottom-left corner at the origin. The measured JSON stays in the case frame: the caller shifts it.
    sx, sy = (float(v) for v in d["shift"])
    case_out, lid_out = Pos(-sx, -sy, 0) * case, Pos(-sx, -sy, 0) * lid_print
    export_step(case_out, str(out / "case.step"))
    export_stl(case_out, str(out / "case.stl"))
    export_step(lid_out, str(out / "lid.step"))
    export_stl(lid_out, str(out / "lid.stl"))

    issues, min_wall = thin_wall_issues(d, conns)
    for name, solid in (("case", case), ("lid", lid_print)):
        if not solid.is_valid:
            issues.append(f"{name}: the solid is not valid")
    issues += stl_manifold_issues(out / "case.stl", "case") + stl_manifold_issues(out / "lid.stl", "lid")
    issues += overhang_issues(case, "case", slots) + overhang_issues(lid_print, "lid", [])
    # The module's antenna hangs past the board edge: measured on the solids, nothing of the case or lid may touch it.
    a = d["antenna"]
    if a:
        box = Pos((a["xMin"] + a["xMax"]) / 2, (a["yMin"] + a["yMax"]) / 2, (a["zMin"] + a["zMax"]) / 2) * Box(a["xMax"] - a["xMin"], a["yMax"] - a["yMin"], a["zMax"] - a["zMin"])
        for name, solid in (("case", case), ("lid", lid)):
            if (solid & box).volume > 1e-6:
                issues.append(f"{name}: runs into the module's antenna, which hangs past the board edge")
    clearance = lid_fit(case, lid, d)
    lo, hi = LID_CLEARANCE_MM
    if not lo - 1e-3 <= clearance <= hi + 1e-3:
        issues.append(f"lid clearance {clearance:.2f} mm per side (needs {lo}-{hi} mm)")
    check = {"ok": not issues, "issues": issues, "minWallMm": round(min_wall, 3), "lidClearanceMm": round(clearance, 3)}

    (out / "cutouts.json").write_text(json.dumps(cutouts, indent=2) + "\n")
    (out / "standoffs.json").write_text(json.dumps(standoffs, indent=2) + "\n")
    (out / "vents.json").write_text(json.dumps(vents, indent=2) + "\n")
    (out / "ports.json").write_text(json.dumps(ports, indent=2) + "\n")
    (out / "features.json").write_text(json.dumps(features, indent=2) + "\n")
    (out / "print.json").write_text(json.dumps(check, indent=2) + "\n")
    verdict = "print check ok" if check["ok"] else f"print check: {len(issues)} issue(s)"
    print(f"case {iw + 2 * d['wall']:.1f}x{ih + 2 * d['wall']:.1f}x{d['height']:.1f} mm + {d['plate']:.1f} mm lid, "
          f"{len(cutouts)} cutouts, {len(standoffs)} standoffs, {len(vents)} vents, {sum(f['ok'] for f in features)}/{len(features)} features; {verdict}")


if __name__ == "__main__":
    main()
