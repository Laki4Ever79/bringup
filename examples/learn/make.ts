// Builds the part learner's synthetic fixtures: datasheets of fictional parts (BRG-AMP1, BRG-SPK40), written by us,
// so no manufacturer's document is in the repo. Run: npx tsx examples/learn/make.ts
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { miniPdf } from "./minipdf.ts"

const DIR = import.meta.dirname

// BRG-AMP1: an I2S class-D amplifier. Page 1 a table, page 2 the pin-out and package (all as text).
const amp = miniPdf([
	{
		text: [
			{ s: "BRG-AMP1 I2S Class-D Amplifier", x: 50, y: 60, size: 16 },
			{ s: "Electrical characteristics", x: 50, y: 110, size: 12 },
			{ s: "Supply voltage VDD", x: 50, y: 140 },
			{ s: "2.5 ~ 5.5 V", x: 300, y: 140 },
			{ s: "Absolute maximum VDD", x: 50, y: 160 },
			{ s: "6.0 V", x: 300, y: 160 },
			{ s: "Minimum load impedance", x: 50, y: 180 },
			{ s: "4 ohm", x: 300, y: 180 },
			{ s: "Output power (5 V, 4 ohm)", x: 50, y: 200 },
			{ s: "3.2 W", x: 300, y: 200 },
			{ s: "Quiescent current", x: 50, y: 220 },
			{ s: "2.4 mA", x: 300, y: 220 },
			{ s: "Input interface", x: 50, y: 240 },
			{ s: "I2S", x: 300, y: 240 },
		],
	},
	{
		text: [
			{ s: "Pin configuration", x: 50, y: 60, size: 12 },
			{ s: "1 SD  2 GAIN  3 DIN  4 BCLK  5 LRCLK  6 GND  7 VDD  8 OUTP  9 OUTN  10 GND", x: 50, y: 90, size: 9 },
			{ s: "Package: QFN-10, 3.0 x 3.0 mm, height 0.75 mm", x: 50, y: 130 },
		],
		lines: [{ x1: 200, y1: 200, x2: 300, y2: 200 }],
	},
])
writeFileSync(join(DIR, "brg-amp1.pdf"), amp)

// BRG-SPK40: a 40 mm speaker driver. Page 1 a table (text); page 2 a mechanical drawing with NO text objects at all,
// standing in for an image-only drawing page.
const spk = miniPdf([
	{
		text: [
			{ s: "BRG-SPK40 40 mm Speaker", x: 50, y: 60, size: 16 },
			{ s: "Nominal impedance", x: 50, y: 120 },
			{ s: "8 ohm", x: 300, y: 120 },
			{ s: "Rated power", x: 50, y: 140 },
			{ s: "3 W", x: 300, y: 140 },
			{ s: "Vas", x: 50, y: 160 },
			{ s: "0.12 L", x: 300, y: 160 },
			{ s: "Qts", x: 50, y: 180 },
			{ s: "0.85", x: 300, y: 180 },
			{ s: "Fs", x: 50, y: 200 },
			{ s: "650 Hz", x: 300, y: 200 },
			{ s: "Terminals: + -", x: 50, y: 220 },
		],
	},
	{
		lines: [
			{ x1: 150, y1: 500, x2: 350, y2: 500 },
			{ x1: 420, y1: 300, x2: 420, y2: 390 },
		],
		circles: [
			{ cx: 250, cy: 350, r: 100 },
			{ cx: 130, cy: 350, r: 6 },
			{ cx: 370, cy: 350, r: 6 },
		],
	},
])
writeFileSync(join(DIR, "brg-spk40.pdf"), spk)

writeFileSync(join(DIR, "landing.html"), "<!doctype html><html><body><h1>BRG-AMP1 product page</h1><a href='/brg-amp1.pdf'>Datasheet</a></body></html>\n")
console.log("wrote brg-amp1.pdf, brg-spk40.pdf, landing.html")
