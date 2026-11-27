"""Pictures of the CNC's simulated toolpath (src/tools/cnc-sim.ts: grblHAL in Renode, its position reported while a short
program ran, each axis's STEP pulses counted at the pins). Plain 2D drawing with Pillow, no CAD kernel needed.

usage: cnc_pictures.py <cncsim rev dir (toolpath.json)> <out dir>
writes cnc-toolpath.png (from above, a millimetre grid, the cut in red and the moves above the work in grey, with an
inset of the bed showing where on it the program ran), cnc-toolpath-3d.png (from the front left, the plunge to depth
visible) and cnc.gif (the tool along the path); prints the files written."""

import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SIZE = (1200, 900)
BG = (246, 245, 241)
GRID = (222, 220, 212)
GRID_MAJOR = (200, 197, 188)
CUT = (204, 52, 44)
AIR = (150, 152, 158)
TOOL = (58, 60, 66)
INK = (60, 60, 64)
BED = (226, 224, 216)


def font(px):
    for name in ("DejaVuSans.ttf", "Arial.ttf", "arial.ttf", "Helvetica.ttc"):
        try:
            return ImageFont.truetype(name, px)
        except OSError:
            continue
    return ImageFont.load_default()


def fit(points, box, pad):
    """A transform (x, y) mm -> pixels that fits the points' extent into box (x0, y0, x1, y1), y up, one scale."""
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    lo_x, hi_x, lo_y, hi_y = min(xs), max(xs), min(ys), max(ys)
    w, h = max(hi_x - lo_x, 1e-3), max(hi_y - lo_y, 1e-3)
    s = min((box[2] - box[0] - 2 * pad) / w, (box[3] - box[1] - 2 * pad) / h)
    cx, cy = (lo_x + hi_x) / 2, (lo_y + hi_y) / 2
    mx, my = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    return (lambda x, y: (mx + (x - cx) * s, my - (y - cy) * s)), s, (lo_x, hi_x, lo_y, hi_y)


def segments(points):
    """Consecutive pairs, each marked cutting when either end is below the work's top (z < 0)."""
    return [(a, b, a[2] < -1e-3 or b[2] < -1e-3) for a, b in zip(points[:-1], points[1:])]


def top_view(points, upto, tp, size=SIZE, inset=True):
    img = Image.new("RGB", size, BG)
    d = ImageDraw.Draw(img)
    # The path's box: the right 26 % kept for the bed's inset when there is one.
    box = (60, 60, size[0] - (int(size[0] * 0.26) + 60 if inset else 60), size[1] - 110)
    to, s, (lo_x, hi_x, lo_y, hi_y) = fit(points, box, 40)
    # A millimetre grid over the path's extent, every 5 mm darker.
    gx0, gx1 = math.floor(lo_x) - 1, math.ceil(hi_x) + 1
    gy0, gy1 = math.floor(lo_y) - 1, math.ceil(hi_y) + 1
    for gx in range(gx0, gx1 + 1):
        d.line([to(gx, gy0), to(gx, gy1)], fill=GRID_MAJOR if gx % 5 == 0 else GRID, width=1)
    for gy in range(gy0, gy1 + 1):
        d.line([to(gx0, gy), to(gx1, gy)], fill=GRID_MAJOR if gy % 5 == 0 else GRID, width=1)
    for a, b, cut in segments(points[: upto + 1]):
        d.line([to(a[0], a[1]), to(b[0], b[1])], fill=CUT if cut else AIR, width=8 if cut else 3)
    x, y = to(points[upto][0], points[upto][1])
    r = max(6, s * 0.5)
    d.ellipse([x - r, y - r, x + r, y + r], outline=TOOL, width=3)
    f = font(max(14, size[1] // 40))
    deepest = min(p[2] for p in points)
    d.text((60, size[1] - 95), f"grblHAL in Renode: the toolpath it reported, {hi_x - lo_x:.1f} x {hi_y - lo_y:.1f} mm, {abs(deepest):.2f} mm deep; 1 mm grid", fill=INK, font=f)
    checks = tp.get("pulseCheck") or []
    if checks:
        d.text((60, size[1] - 65), "STEP pulses at the pins: " + "; ".join(f"{c['axis'].upper()} {c['detail'].split(' = ')[1].split(' at ')[0]} {'ok' if c['ok'] else 'MISMATCH'}" for c in checks), fill=INK, font=f)
    if inset:
        draw_bed_inset(d, tp, points, size)
    return img


def draw_bed_inset(d, tp, points, size):
    """The bed (the machine's work area) small in a corner, the program's place on it marked."""
    area = tp.get("workAreaMm") or {}
    if not area.get("x") or not area.get("y"):
        return
    w = size[0] * 0.22
    h = w * area["y"] / area["x"]
    x0, y0 = size[0] - w - 30, 60
    d.rectangle([x0, y0, x0 + w, y0 + h], fill=BED, outline=GRID_MAJOR, width=2)
    o = tp.get("originMm") or [0, 0, 0]
    k = w / area["x"]
    px, py = x0 + o[0] * k, y0 + h - o[1] * k
    d.ellipse([px - 5, py - 5, px + 5, py + 5], fill=CUT)
    d.text((x0, y0 + h + 6), f"the bed, {area['x']:g} x {area['y']:g} mm: where it ran", fill=INK, font=font(14))


def oblique(points, upto, size=SIZE):
    """From the front left and above: x right, y into the picture (raised), z up; the cut red, the moves above grey."""
    def proj(p):
        return (p[0] + p[1] * 0.55, p[1] * 0.35 + p[2] * 2.2)  # z exaggerated 2.2x so a 1 mm plunge reads

    img = Image.new("RGB", size, BG)
    d = ImageDraw.Draw(img)
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    corners = [(min(xs) - 1, min(ys) - 1, 0), (max(xs) + 1, min(ys) - 1, 0), (max(xs) + 1, max(ys) + 1, 0), (min(xs) - 1, max(ys) + 1, 0)]
    to, s, _ = fit([proj(p) for p in points] + [proj(c) for c in corners], (60, 60, size[0] - 60, size[1] - 100), 40)
    d.line([to(*proj(c)) for c in corners + corners[:1]], fill=GRID_MAJOR, width=2)  # the work's top, z 0
    for a, b, cut in segments(points[: upto + 1]):
        d.line([to(*proj(a)), to(*proj(b))], fill=CUT if cut else AIR, width=5 if cut else 3)
    tip = to(*proj(points[upto]))
    d.line([tip, (tip[0], tip[1] - 60)], fill=TOOL, width=10)
    d.text((60, size[1] - 80), "the same toolpath from the front left: grey: the work's top; red: the cut below it (depth x2.2)", fill=INK, font=font(max(14, size[1] // 40)))
    return img


def main():
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    tp = json.loads((src / "toolpath.json").read_text())
    points = [tuple(p) for p in tp.get("points", [])]
    if len(points) < 2:
        print("cnc_pictures: the toolpath has fewer than two points", file=sys.stderr)
        sys.exit(1)
    last = len(points) - 1
    top_view(points, last, tp).save(out / "cnc-toolpath.png")
    oblique(points, last).save(out / "cnc-toolpath-3d.png")
    frames = [top_view(points, i, tp, size=(640, 480), inset=False).convert("P", palette=1, colors=64) for i in range(len(points))]
    frames[0].save(out / "cnc.gif", save_all=True, append_images=frames[1:], duration=120, loop=0, optimize=True)
    print("\n".join(["cnc-toolpath.png", "cnc-toolpath-3d.png", "cnc.gif"]))


if __name__ == "__main__":
    main()
