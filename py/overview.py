"""The whole design in one picture (get_pictures overview: true): up to three of a run's pictures side by side, each
fitted into its panel at one height and labelled underneath (the board, the assembly, the motion). Pillow only.

usage: overview.py <out.png> [--row=<title>] <label>=<picture> ... [--row=<title> ...] [--caption=<text>]
a label starting with * marks that panel changed (a red frame and tag); several --row draw rows one above the other
(get_pictures compare: before above after). Writes out.png and prints its name."""

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


def trim_letterbox(pic):
    """A render on a dark letterbox (KiCad's board.png: the board on black): cropped to what isn't the corners' dark
    colour, with a small margin, so it sits on the panel's light background like the other pictures."""
    corners = [pic.getpixel(c) for c in ((0, 0), (pic.width - 1, 0), (0, pic.height - 1), (pic.width - 1, pic.height - 1))]
    if not all(sum(c) < 60 for c in corners):
        return pic
    mask = pic.convert("L").point(lambda v: 255 if v > 24 else 0)
    box = mask.getbbox()
    if not box:
        return pic
    m = 0  # flush: a margin brought the black back as a frame
    return pic.crop((max(0, box[0] - m), max(0, box[1] - m), min(pic.width, box[2] + m), min(pic.height, box[3] + m)))


MARK = (204, 52, 44)
ROW_HEAD = 46
CAPTION_H = 64


def parse(args):
    """[--row=<title>] label=path ... [--caption=<text>]; a label starting with * marks its panel changed. Without --row:
    one untitled row (the overview); with them: one row per --row (before above after)."""
    rows, caption = [], None
    for arg in args:
        if arg.startswith("--row="):
            rows.append((arg[6:], []))
        elif arg.startswith("--caption="):
            caption = arg[10:]
        else:
            if not rows:
                rows.append((None, []))
            label, _, path = arg.partition("=")
            changed = label.startswith("*")
            if Path(path).exists():
                rows[-1][1].append((label.lstrip("*"), Path(path), changed))
    return [r for r in rows if r[1]], caption


def main():
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    out = Path(sys.argv[1])
    rows, caption = parse(sys.argv[2:])
    if not rows:
        print("overview: none of the pictures exist", file=sys.stderr)
        sys.exit(1)
    cols = max(len(r[1]) for r in rows)
    titled = any(t for t, _ in rows)
    row_h = (ROW_HEAD if titled else 0) + PANEL[1] + LABEL_H + GAP
    w = GAP + cols * (PANEL[0] + GAP)
    h = GAP + len(rows) * row_h + (CAPTION_H if caption else 0)
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)
    f, fb = font(26), font(30)
    for r, (title, panels) in enumerate(rows):
        y0 = GAP + r * row_h
        if title:
            d.text((GAP, y0 + 4), title, fill=INK, font=fb)
            y0 += ROW_HEAD
        for i, (label, path, changed) in enumerate(panels):
            x0 = GAP + i * (PANEL[0] + GAP)
            d.rectangle([x0, y0, x0 + PANEL[0], y0 + PANEL[1] + LABEL_H], fill=CARD, outline=MARK if changed else RULE, width=6 if changed else 2)
            pic = trim_letterbox(Image.open(path).convert("RGB"))
            pic.thumbnail((PANEL[0] - 16, PANEL[1] - 16), Image.LANCZOS)
            img.paste(pic, (x0 + (PANEL[0] - pic.width) // 2, y0 + (PANEL[1] - pic.height) // 2))
            d.line([x0, y0 + PANEL[1], x0 + PANEL[0], y0 + PANEL[1]], fill=MARK if changed else RULE, width=2)
            d.text((x0 + 18, y0 + PANEL[1] + 14), label, fill=INK, font=f)
            if changed:
                tag = "changed"
                tw = d.textlength(tag, font=f)
                d.rectangle([x0 + PANEL[0] - tw - 34, y0 + 12, x0 + PANEL[0] - 12, y0 + 52], fill=MARK)
                d.text((x0 + PANEL[0] - tw - 23, y0 + 17), tag, fill=(255, 255, 255), font=f)
    if caption:
        d.text((GAP, h - CAPTION_H + 12), caption, fill=INK, font=f)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, optimize=True)
    print(out.name)


if __name__ == "__main__":
    main()
