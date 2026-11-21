// The README's robot pictures, rerunnable: npx tsx scripts/readme-images.ts <run folder> [prefix]
// Draws the run's robot in the dashboard's 3D view, exploded and at the last assembly step (src/package/assembly-pictures.ts,
// headless Chromium), and copies them into docs/img as <prefix>-exploded.png and <prefix>-assembled.png. Only the 3D view
// is captured: no keys, paths or settings are on screen.
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { assemblyPictures } from "../src/package/assembly-pictures.ts"

const [run, prefix = "robot"] = process.argv.slice(2)
if (!run) {
	console.error("usage: npx tsx scripts/readme-images.ts <run folder> [prefix]")
	process.exit(2)
}
const out = mkdtempSync(join(tmpdir(), "bringup-readme-img-"))
const r = await assemblyPictures(resolve(run), out, (m) => console.log(m))
const files = readdirSync(join(out, "assembly")).filter((f) => f.endsWith(".png")).sort()
if (!files.length) {
	console.error("no pictures:", JSON.stringify(r).slice(0, 300))
	process.exit(1)
}
const steps = files.filter((f) => f.startsWith("step-")).sort((a, b) => Number(/step-(\d+)/.exec(a)![1]) - Number(/step-(\d+)/.exec(b)![1]))
copyFileSync(join(out, "assembly", "exploded.png"), resolve("docs/img", `${prefix}-exploded.png`))
copyFileSync(join(out, "assembly", steps.at(-1)!), resolve("docs/img", `${prefix}-assembled.png`))
// Trimmed to the robot with a margin (the 3D view leaves it a narrow strip of a wide frame), with .venv's Pillow.
const trim = `import sys
from PIL import Image, ImageChops
for p in sys.argv[1:]:
    im = Image.open(p).convert("RGB")
    diff = ImageChops.difference(im, Image.new("RGB", im.size, im.getpixel((2, 2)))).convert("L")
    box = diff.point(lambda v: 255 if v > 24 else 0).getbbox()
    if box:
        m = 24
        im.crop((max(0, box[0] - m), max(0, box[1] - m), min(im.width, box[2] + m), min(im.height, box[3] + m))).save(p)`
execFileSync(resolve(".venv/bin/python"), ["-c", trim, ...["exploded", "assembled"].map((k) => resolve("docs/img", `${prefix}-${k}.png`))])
console.log(`docs/img/${prefix}-exploded.png, docs/img/${prefix}-assembled.png (from ${steps.at(-1)})`)
rmSync(out, { recursive: true, force: true })
