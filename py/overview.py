"""The whole design in one picture (get_pictures overview: true): up to three of a run's pictures side by side, each
fitted into its panel at one height and labelled underneath (the board, the assembly, the motion). Pillow only.

usage: overview.py <out.png> <label>=<picture> [<label>=<picture> ...]
writes out.png and prints its name."""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

PANEL = (720, 540)
GAP = 24
LABEL_H = 56
BG = (246, 245, 241)
CARD = (255, 255, 255)
INK = (60, 60, 64)
RULE = (222, 220, 212)


def font(px):
    for name in ("DejaVuSans.ttf", "Arial.ttf", "arial.ttf", "Helvetica.ttc"):
        try:
            return ImageFont.truetype(name, px)
        except OSError:
            continue
    return ImageFont.load_default()


def main():
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    out = Path(sys.argv[1])
    panels = []
    for arg in sys.argv[2:]:
        label, _, path = arg.partition("=")
        p = Path(path)
        if p.exists():
            panels.append((label, p))
    if not panels:
        print("overview: none of the pictures exist", file=sys.stderr)
        sys.exit(1)
    w = GAP + len(panels) * (PANEL[0] + GAP)
    h = GAP + PANEL[1] + LABEL_H + GAP
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)
    f = font(26)
    for i, (label, path) in enumerate(panels):
        x0 = GAP + i * (PANEL[0] + GAP)
        d.rectangle([x0, GAP, x0 + PANEL[0], GAP + PANEL[1] + LABEL_H], fill=CARD, outline=RULE, width=2)
        pic = Image.open(path).convert("RGB")
        pic.thumbnail((PANEL[0] - 16, PANEL[1] - 16), Image.LANCZOS)
        img.paste(pic, (x0 + (PANEL[0] - pic.width) // 2, GAP + (PANEL[1] - pic.height) // 2))
        d.line([x0, GAP + PANEL[1], x0 + PANEL[0], GAP + PANEL[1]], fill=RULE, width=2)
        d.text((x0 + 18, GAP + PANEL[1] + 14), label, fill=INK, font=f)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, optimize=True)
    print(out.name)


if __name__ == "__main__":
    main()
