"""Print checks shared by the printed parts (py/chassis.py; py/enclosure.py has its own, older ones): whether a part
fits the printer's bed in any orientation, and which faces would need support as built. text-to-cad's lesson 5
(design for the process), 22 Nov 2026."""

MIN_WALL_MM = 1.2  # three 0.4 mm perimeters (py/enclosure.py MIN_WALL_MM)
OVERHANG_COS = 0.7071  # a face pointing down more than 45 degrees needs support


def bed_issue(name, solid, bed_mm):
    """None when the part fits the bed laid on one of its faces (its box's sorted sides within the bed's), else why."""
    bb = solid.bounding_box()
    dims = sorted((bb.size.X, bb.size.Y, bb.size.Z))
    bed = sorted(bed_mm)
    if all(d <= b + 1e-6 for d, b in zip(dims, bed)):
        return None
    return f"{name}: {bb.size.X:.0f} x {bb.size.Y:.0f} x {bb.size.Z:.0f} mm doesn't fit a {' x '.join(f'{b:g}' for b in bed_mm)} mm bed in any orientation"


def wall_issues(walls):
    """Each designed wall thinner than three perimeters. walls: {name: thickness in mm}."""
    return [f"{k}: {v:g} mm wall < {MIN_WALL_MM} mm" for k, v in walls.items() if v < MIN_WALL_MM - 1e-9]


def support_notes(name, solid):
    """Where the part, printed as built and lifted onto the bed, needs support: faces off the bed pointing down more
    than 45 degrees, summed by area. A note, not an issue: support costs time and material, it doesn't stop a print."""
    z0 = solid.bounding_box().min.Z
    area, faces = 0.0, 0
    for face in solid.faces():
        if face.bounding_box().min.Z - z0 < 1e-3:
            continue
        try:
            n = face.normal_at(face.center())
        except Exception:  # noqa: BLE001 - a face that can't be oriented is skipped
            continue
        if n.Z < -OVERHANG_COS - 1e-6:
            area += face.area
            faces += 1
    return [f"{name}: {faces} downward face(s), {area:.0f} mm² in all, need support printed as built"] if faces else []
