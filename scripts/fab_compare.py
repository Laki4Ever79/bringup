"""Compares two Gerber/Excellon sets of the same board layer by layer: KiCad's export (src/tools/fab.ts) against
tscircuit's (tsci export -f gerbers), before tscircuit's may stand in for KiCad's (fab files without KiCad, 26 Nov 2026).

Per layer: each set rasterised at 0.05 mm in the outline's frame (the two exports place the board at different origins),
the area each covers and the share of the union where they disagree. Drills: holes matched by position (within 0.1 mm)
and diameter (within 0.05 mm). Run with a Python that has pygerber 2.4 (`uv pip install "pygerber[pillow]==2.4.3"`):

  python scripts/fab_compare.py <kicad gerbers dir> <tscircuit gerbers dir>   # prints JSON
"""

import json
import re
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from pygerber.gerberx3.api.v2 import GerberFile

DPMM = 20  # 0.05 mm a pixel
LAYERS = {  # our layer name: (KiCad file suffix, tscircuit file)
    "F_Cu": (".gtl", "F_Cu.gbr"),
    "B_Cu": (".gbl", "B_Cu.gbr"),
    "F_Mask": (".gts", "F_Mask.gbr"),
    "B_Mask": (".gbs", "B_Mask.gbr"),
    "F_Paste": (".gtp", "F_Paste.gbr"),
    "B_Paste": (".gbp", "B_Paste.gbr"),
    "F_Silkscreen": (".gto", "F_SilkScreen.gbr"),
    "B_Silkscreen": (".gbo", "B_SilkScreen.gbr"),
    "Edge_Cuts": (".gm1", "Edge_Cuts.gbr"),
}


def find(d: Path, suffix: str):
    hits = [p for p in d.iterdir() if p.name.endswith(suffix)]
    return hits[0] if hits else None


def raster(path: Path, centre, size_px):
    """The layer as a boolean image in the outline's frame (centre in mm), size_px (w, h)."""
    parsed = GerberFile.from_file(path).parse()
    info = parsed.get_info()
    out = Path("/tmp") / f"fabcmp-{abs(hash(str(path)))}.png"
    parsed.render_raster(out, dpmm=DPMM)
    img = np.asarray(Image.open(out).convert("L")) > 0  # pygerber draws the layer in colour on black
    out.unlink(missing_ok=True)
    w, h = size_px
    canvas = np.zeros((h, w), dtype=bool)
    # The image's top-left corner is (min_x, max_y) in mm; place it relative to the outline's centre.
    x0 = int(round((float(info.min_x_mm) - centre[0]) * DPMM + w / 2))
    y0 = int(round((centre[1] - float(info.max_y_mm)) * DPMM + h / 2))
    ih, iw = img.shape
    xs, ys = max(0, x0), max(0, y0)
    xe, ye = min(w, x0 + iw), min(h, y0 + ih)
    if xe > xs and ye > ys:
        canvas[ys:ye, xs:xe] = img[ys - y0 : ye - y0, xs - x0 : xe - x0]
    return canvas


def outline(path: Path):
    i = GerberFile.from_file(path).parse().get_info()
    return ((float(i.min_x_mm) + float(i.max_x_mm)) / 2, (float(i.min_y_mm) + float(i.max_y_mm)) / 2), (float(i.max_x_mm) - float(i.min_x_mm), float(i.max_y_mm) - float(i.min_y_mm))


def holes(paths, centre):
    """[(x, y, diameter)] from Excellon files, relative to the outline's centre (metric, decimal)."""
    out = []
    for p in paths:
        tools, cur = {}, None
        for line in p.read_text().splitlines():
            line = line.strip()
            m = re.match(r"^T(\d+)C([\d.]+)", line)
            if m:
                tools[m.group(1)] = float(m.group(2))
                continue
            m = re.match(r"^T(\d+)$", line)
            if m:
                cur = tools.get(m.group(1))
                continue
            # A slot (G85): its two ends, on one line (KiCad: X..Y..G85X..Y..) or the end on the line after the start
            # (tscircuit: X..Y.. then G85X..Y..); kept as its middle, so both writers' slots compare.
            m = re.match(r"^(?:X(-?[\d.]+)Y(-?[\d.]+))?G85X(-?[\d.]+)Y(-?[\d.]+)", line)
            if m and cur is not None:
                if m.group(1) is None and out:
                    x0, y0, d = out.pop()
                    x0, y0 = x0 + centre[0], y0 + centre[1]
                else:
                    x0, y0 = float(m.group(1)), float(m.group(2))
                x1, y1 = float(m.group(3)), float(m.group(4))
                out.append(((x0 + x1) / 2 - centre[0], (y0 + y1) / 2 - centre[1], cur))
                continue
            m = re.match(r"^X(-?[\d.]+)Y(-?[\d.]+)$", line)
            if m and cur is not None:
                out.append((float(m.group(1)) - centre[0], float(m.group(2)) - centre[1], cur))
    return out


def compare(kdir: Path, tdir: Path):
    kc, ksize = outline(find(kdir, ".gm1"))
    tc, tsize = outline(tdir / "Edge_Cuts.gbr")
    w, h = int(max(ksize[0], tsize[0]) * DPMM) + 40, int(max(ksize[1], tsize[1]) * DPMM) + 40
    report = {"outline": {"kicad_mm": [round(v, 3) for v in ksize], "tscircuit_mm": [round(v, 3) for v in tsize]}, "layers": {}}
    for name, (ksuf, tname) in LAYERS.items():
        kp, tp = find(kdir, ksuf), tdir / tname
        if not kp or not tp.exists():
            report["layers"][name] = {"missing": [x for x, ok in (("kicad", kp), ("tscircuit", tp.exists())) if not ok]}
            continue
        a, b = raster(kp, kc, (w, h)), raster(tp, tc, (w, h))
        # The two outlines differ by their line width, so the frames can sit a pixel apart: the front copper fixes the
        # whole-pixel shift (within ±0.1 mm) that lines the boards up best, and every layer uses it.
        # Each layer's image starts at its own rounded corner, so the shift is found per layer.
        shift = min(((dx, dy) for dx in range(-2, 3) for dy in range(-2, 3)), key=lambda s: np.logical_xor(a, np.roll(b, s, axis=(1, 0))).sum())
        b = np.roll(b, shift, axis=(1, 0))
        union = np.logical_or(a, b).sum()
        diff = np.logical_xor(a, b).sum()
        report["layers"][name] = {"kicad_mm2": round(a.sum() / DPMM**2, 1), "tscircuit_mm2": round(b.sum() / DPMM**2, 1), "disagree_pct": round(100 * diff / union, 2) if union else 0.0, "shift_mm": [v / DPMM for v in shift]}
    kh = holes([p for p in kdir.iterdir() if p.suffix == ".drl"], kc)
    th = holes([p for p in tdir.iterdir() if p.suffix == ".drl"], tc)
    used, matched = set(), 0
    for x, y, d in kh:
        for i, (u, v, e) in enumerate(th):
            if i not in used and abs(u - x) <= 0.1 and abs(v - y) <= 0.1 and abs(e - d) <= 0.05:
                used.add(i)
                matched += 1
                break
    sizes = lambda hs: {f"{d:.2f}": sum(1 for *_, e in hs if f"{e:.2f}" == f"{d:.2f}") for *_, d in hs}
    report["drills"] = {"kicad": len(kh), "tscircuit": len(th), "matched": matched, "kicad_sizes": sizes(kh), "tscircuit_sizes": sizes(th)}
    return report


if __name__ == "__main__":
    print(json.dumps(compare(Path(sys.argv[1]), Path(sys.argv[2])), indent=1))
