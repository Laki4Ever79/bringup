"""Still pictures of the assembled robot for the build package, without the hosted page (the open-core split, 25 Nov
2026): the printed chassis from the run's own STL and the bought parts as py/chassis.py places them, drawn by a small
flat-shaded painter's-algorithm rasterizer (numpy + Pillow). One picture per assembly step (src/geometry/assembly-steps.js,
the parts up to that step), one exploded, and a top and a side view of the whole robot.

usage: stills.py <chassis rev dir (spec.json, chassis.stl)> <out dir> <step names, comma-separated>
prints the files written, one per line."""

import json
import math
import struct
import sys
from pathlib import Path

import numpy as np
from build123d import Box, Cylinder, Pos
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).parent))
from chassis import bought_parts, mast_sections, strap  # noqa: E402

SIZE = (1200, 900)
SS = 2  # supersampling, for smooth edges
BG = (246, 245, 241)
FLOOR = (226, 224, 216)
COLOURS = {
    "plate": (236, 140, 52),  # printed PLA
    "motors": (150, 156, 164),
    "wheels": (40, 40, 44),
    "board": (32, 110, 70),
    "battery": (52, 92, 170),
    "sensor": (120, 60, 150),
    "top": (200, 50, 46),
}
LIGHT = np.array([-0.35, -0.55, 0.76])
LIGHT = LIGHT / np.linalg.norm(LIGHT)


def read_stl(path):
    """Triangles (n, 3, 3) from a binary or ASCII STL."""
    data = Path(path).read_bytes()
    if data[:5] == b"solid" and b"facet" in data[:400]:
        v = [list(map(float, line.split()[1:4])) for line in data.decode(errors="ignore").splitlines() if line.strip().startswith("vertex")]
        return np.array(v, dtype=float).reshape(-1, 3, 3)
    n = struct.unpack("<I", data[80:84])[0]
    rec = np.frombuffer(data[84:84 + n * 50], dtype=np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]))
    return rec["v"].astype(float)


def tris(shape, tol=0.4):
    """Triangles (n, 3, 3) of a build123d shape."""
    verts, faces = shape.tessellate(tol, math.radians(15))
    v = np.array([[p.X, p.Y, p.Z] for p in verts], dtype=float)
    return v[np.array(faces, dtype=int)] if len(faces) else np.zeros((0, 3, 3))


def groups(spec, rev):
    """The robot's parts by assembly step: {step: [triangles]}, in the chassis frame (z 0 the plate's underside)."""
    g = {k: [] for k in COLOURS}
    g["plate"].append(read_stl(rev / "chassis.stl"))
    for name, solid in bought_parts(spec):
        step = "board" if name.startswith("board") else "battery" if name == "battery" else "motors" if name.endswith("motor") else "wheels" if name.endswith("wheel") else "sensor" if name == "sensor" else "top"
        g[step].append(tris(solid))
    c = spec.get("caster")
    if c:
        drop = spec["plate"]["clearanceMm"]
        r = c["wheelMm"] / 2
        g["wheels"].append(tris(Pos(c["xMm"], 0, -drop + r) * Cylinder(r, r * 0.7, rotation=(90, 0, 0))))
        g["wheels"].append(tris(Pos(c["xMm"], 0, -(drop - 2 * r) / 2) * Box(r * 1.6, r * 1.2, max(drop - 2 * r, 1))))
    try:
        g["battery"].append(tris(strap(spec)))
    except Exception:  # noqa: BLE001 - an old spec without a strap: the pack alone
        pass
    if spec.get("beacon"):
        for sec, _ in mast_sections(spec):
            g["top"].append(tris(sec))
    return {k: np.concatenate(v) if v else np.zeros((0, 3, 3)) for k, v in g.items()}


def camera(yaw_deg, pitch_deg):
    """World → view rotation: x right, y up, z toward the viewer."""
    yaw, pitch = math.radians(yaw_deg), math.radians(pitch_deg)
    fwd = np.array([math.cos(pitch) * math.cos(yaw), math.cos(pitch) * math.sin(yaw), math.sin(pitch)])  # eye direction from target
    right = np.cross([0, 0, 1], fwd)
    right = right / np.linalg.norm(right) if np.linalg.norm(right) > 1e-6 else np.array([0, 1, 0])
    up = np.cross(fwd, right)
    return np.stack([right, up, fwd])


def render(parts, path, yaw, pitch, floor_z, extent=None):
    """parts: [(triangles, colour)]. An orthographic view, fitted to `extent` (the whole robot's points) so every step
    of a sequence is drawn at one scale."""
    R = camera(yaw, pitch)
    allpts = extent if extent is not None else np.concatenate([t.reshape(-1, 3) for t, _ in parts])
    lo, hi = allpts.min(0), allpts.max(0)
    centre = (lo + hi) / 2
    # A floor square under the robot.
    span = max(hi[0] - lo[0], hi[1] - lo[1]) * 0.8 + 40
    f = np.array([[centre[0] - span, centre[1] - span, floor_z], [centre[0] + span, centre[1] - span, floor_z], [centre[0] + span, centre[1] + span, floor_z], [centre[0] - span, centre[1] + span, floor_z]])
    view = (allpts - centre) @ R.T
    w, h = SIZE[0] * SS, SIZE[1] * SS
    scale = 0.82 * min(w / max(np.ptp(view[:, 0]), 1), h / max(np.ptp(view[:, 1]), 1))
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)

    mid = (view.min(0) + view.max(0)) / 2  # the drawing's own centre on screen (not the world box's)

    def proj(p):
        q = (p - centre) @ R.T
        return np.stack([w / 2 + (q[..., 0] - mid[0]) * scale, h / 2 - (q[..., 1] - mid[1]) * scale], -1), q[..., 2]

    if pitch > 5:
        fp, _ = proj(f)
        d.polygon([tuple(x) for x in fp], fill=FLOOR)
    # A depth buffer (not painter's order: a plate's long triangles would paint over what stands on it).
    rgb = np.asarray(img, dtype=np.uint8).copy()
    zbuf = np.full((h, w), -np.inf)
    for t, colour in parts:
        if not len(t):
            continue
        n = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
        ln = np.linalg.norm(n, axis=1)
        ok = ln > 1e-12
        t, n = t[ok], n[ok] / ln[ok, None]
        xy, z = proj(t)
        shade = 0.45 + 0.55 * np.abs(n @ LIGHT)
        cols = np.clip(np.array(colour, dtype=float) * shade[:, None], 0, 255).astype(np.uint8)
        for i in range(len(t)):
            (x0, y0), (x1, y1), (x2, y2) = xy[i]
            a = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
            if abs(a) < 1e-9:
                continue
            bx0, bx1 = max(int(min(x0, x1, x2)), 0), min(int(max(x0, x1, x2)) + 1, w)
            by0, by1 = max(int(min(y0, y1, y2)), 0), min(int(max(y0, y1, y2)) + 1, h)
            if bx0 >= bx1 or by0 >= by1:
                continue
            px, py = np.meshgrid(np.arange(bx0, bx1) + 0.5, np.arange(by0, by1) + 0.5)
            w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / a
            w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / a
            w2 = 1 - w0 - w1
            inside = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
            if not inside.any():
                continue
            depth = w0 * z[i, 0] + w1 * z[i, 1] + w2 * z[i, 2]
            zb = zbuf[by0:by1, bx0:bx1]
            win = inside & (depth > zb)
            zb[win] = depth[win]
            rgb[by0:by1, bx0:bx1][win] = cols[i]
    img = Image.fromarray(rgb)
    img.resize(SIZE, Image.LANCZOS).save(path)


def main():
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    rev, out = Path(sys.argv[1]), Path(sys.argv[2])
    steps = [s for s in sys.argv[3].split(",") if s]
    spec = json.loads((rev / "spec.json").read_text())
    g = groups(spec, rev)
    out.mkdir(parents=True, exist_ok=True)
    floor_z = -spec["plate"]["clearanceMm"]
    order = [s for s in steps if s in g] + [k for k in g if k not in steps]
    whole = np.concatenate([g[k].reshape(-1, 3) for k in order if len(g[k])] + [np.array([[0, 0, floor_z]])])
    written = []
    yaw, pitch = 35, 28  # from the front left, above
    for k, name in enumerate(steps):
        upto = steps[: k + 1]
        file = f"step-{k + 1}-{name}.png"
        render([(g[s], COLOURS[s]) for s in upto if s in g], out / file, yaw, pitch, floor_z, whole)
        written.append(file)
    # Exploded: each step's parts lifted by its place in the order.
    lift = 30.0
    exploded = [(g[s] + np.array([0, 0, i * lift]), COLOURS[s]) for i, s in enumerate(order)]
    render(exploded, out / "exploded.png", yaw, pitch, floor_z)
    written.append("exploded.png")
    full = [(g[s], COLOURS[s]) for s in order]
    render(full, out / "view-top.png", 0, 89.5, floor_z)
    render(full, out / "view-side.png", 90, 4, floor_z)
    written += ["view-top.png", "view-side.png"]
    print("\n".join(written))


if __name__ == "__main__":
    main()
