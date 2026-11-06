"""Bed-of-nails test fixture built from the design contract: a printed plate that holds one pogo probe under each of
the board's bottom-side test pads, a nest that locates the board by its outline, and an alignment pin through each
mounting hole.

usage: fixture.py <spec.json> <outdir>

spec = {outline: {widthMm, heightMm, thicknessMm}, probes: [{ref, net, xMm, yMm}], holes: [{ref, xMm, yMm, diameterMm}]}

Frame: the board's bottom-left corner is the origin, top view (x along widthMm, y along heightMm), the same frame as
the contract and the case. The plate's underside is z = 0. The board lies face up on the supports, so each probe points
up at the pad above it; nothing is mirrored.

Probe holes are sized for press-fit receptacles of the common 100-mil (2.54 mm) pogo-pin series. The figures below are
typical catalogue values, not one vendor's datasheet: check them against the probes you buy and change RECEPTACLE_MM.

Outputs: fixture.step/.stl, fixture.json (each probe hole measured back from the solid: open or not; issues).
"""

import json
import sys
from pathlib import Path

from build123d import Box, Cylinder, Pos, export_step, export_stl

PLATE_MM = 6.0  # holds the receptacles straight
RIM_MM = 3.0  # nest wall
NEST_MM = 4.0  # nest wall height above the supports' top
CLEARANCE_MM = 0.3  # board edge to nest wall, per side
SUPPORT_MM = 3.0  # the board's underside sits this far above the plate: room for the probes' travel
SUPPORT_DIA_MM = 5.0
PIN_CLEARANCE_MM = 0.2  # alignment pin diameter = mounting hole - this
PIN_MM = 3.0  # how far the pin rises above the support: through a 1.6 mm board with lead-in
RECEPTACLE_MM = 1.7  # typical press-fit hole for a 100-mil-series receptacle (assumption, see above)


def fail(msg):
    print(msg, file=sys.stderr)
    sys.exit(1)


def main():
    if len(sys.argv) != 3:
        fail("usage: fixture.py <spec.json> <outdir>")
    spec = json.loads(Path(sys.argv[1]).read_text())
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    w, h = float(spec["outline"]["widthMm"]), float(spec["outline"]["heightMm"])
    probes, holes = spec["probes"], spec["holes"]
    if not probes:
        fail("no test pads to probe")

    ow, oh = w + 2 * (CLEARANCE_MM + RIM_MM), h + 2 * (CLEARANCE_MM + RIM_MM)
    plate = Pos(w / 2, h / 2, PLATE_MM / 2) * Box(ow, oh, PLATE_MM)
    rim_h = SUPPORT_MM + NEST_MM
    rim = Pos(w / 2, h / 2, PLATE_MM + rim_h / 2) * (Box(ow, oh, rim_h) - Box(w + 2 * CLEARANCE_MM, h + 2 * CLEARANCE_MM, rim_h))
    fixture = plate + rim

    # Supports under the board: at the mounting holes, with a pin through each; without holes, at the four corners.
    top = PLATE_MM + SUPPORT_MM
    spots = [(float(x["xMm"]), float(x["yMm"]), float(x["diameterMm"])) for x in holes] or [(x, y, 0.0) for x in (3, w - 3) for y in (3, h - 3)]
    for x, y, d in spots:
        fixture = fixture + Pos(x, y, PLATE_MM + SUPPORT_MM / 2) * Cylinder(SUPPORT_DIA_MM / 2, SUPPORT_MM)
        if d > 0:
            fixture = fixture + Pos(x, y, top + PIN_MM / 2) * Cylinder((d - PIN_CLEARANCE_MM) / 2, PIN_MM)

    issues = []
    for p in probes:
        x, y = float(p["xMm"]), float(p["yMm"])
        for sx, sy, _ in spots:
            if ((x - sx) ** 2 + (y - sy) ** 2) ** 0.5 < (SUPPORT_DIA_MM + RECEPTACLE_MM) / 2:
                issues.append(f"{p['ref']}: probe hole runs into the support at ({sx}, {sy})")
        fixture = fixture - Pos(x, y, PLATE_MM / 2) * Cylinder(RECEPTACLE_MM / 2, PLATE_MM * 3)

    # Measured back from the solid: a thin rod down each probe's axis touches nothing when the hole is really open.
    measured = []
    for p in probes:
        rod = Pos(float(p["xMm"]), float(p["yMm"]), PLATE_MM / 2) * Cylinder(RECEPTACLE_MM / 4, PLATE_MM)
        touched = (fixture & rod).volume
        measured.append({"ref": p["ref"], "net": p["net"], "xMm": p["xMm"], "yMm": p["yMm"], "open": touched < 1e-6})
        if touched >= 1e-6:
            issues.append(f"{p['ref']}: the probe hole is blocked")
    if not fixture.is_valid:
        issues.append("the fixture solid is not valid")

    export_step(fixture, str(out / "fixture.step"))
    export_stl(fixture, str(out / "fixture.stl"))
    report = {
        "ok": not issues,
        "issues": issues,
        "probes": measured,
        "sizeMm": [round(ow, 2), round(oh, 2), round(PLATE_MM + rim_h, 2)],
        "probeHoleMm": RECEPTACLE_MM,
        "boardUndersideMm": top,
        "assumption": "probe holes sized for typical 100-mil-series press-fit receptacles; check against your probes",
    }
    (out / "fixture.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"fixture {ow:.1f}x{oh:.1f}x{PLATE_MM + rim_h:.1f} mm, {len(probes)} probes, {len(spots)} supports; {'ok' if report['ok'] else f'{len(issues)} issue(s)'}")


if __name__ == "__main__":
    main()
