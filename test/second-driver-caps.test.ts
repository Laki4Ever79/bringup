// Real run 21 (Eurobot, 25 Nov 2026): every board build after rev 11 failed on "the 5mm maximum length for .U9 > .VINT
// to .C7 > .pin1 cannot be satisfied: its endpoints are 13-30 mm apart". U9, the second DRV8833 (the spare motor), was
// placed only in the last pass, after the capacitors: they had no pin to sit beside. The servo buck's (SY8368A) BS and
// VCC capacitors had no pad positions at all. Each failed build took 13-19 min, six doomed layouts and a Freerouting pass.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { layoutBoard, supportParts, unreachableCaps } from "../src/codegen/circuit.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

const D = new URL("./fixtures/", import.meta.url)
const fx = (f: string) => JSON.parse(readFileSync(new URL(f, D), "utf8")) as ContractSnapshot
const run21 = () => {
	const s = fx("cc-eurobot-21-rev27.json")
	// The space check's smallest board with every part placed (42×61 was the architect's size before the fix).
	s.values.outline = { ...s.values.outline!, widthMm: 44, heightMm: 61 }
	return s
}
// How far each pin capacitor sits off its part's box (0 = touching).
const offBox = (s: ContractSnapshot) => {
	const placed = layoutBoard(s).parts
	const at = (r: string) => placed.find((p) => p.ref === r)
	return supportParts(s).filter((sp) => sp.added && sp.spec.kind === "capacitor" && "ref" in sp.a).map((sp) => {
		const [c, o] = [at(sp.ref), at((sp.a as { ref: string }).ref)]
		assert.ok(c && o, `${sp.ref} placed`)
		return { cap: sp.ref, part: o.ref, mm: Math.max(Math.abs(c.x - o.x) - (c.w + o.w) / 2, Math.abs(c.y - o.y) - (c.h + o.h) / 2) }
	})
}

test("run 21: both DRV8833s and the SY8368A keep their pin capacitors beside them (was 17-35 mm for U9, U2 and U8)", () => {
	const s = run21()
	const far = offBox(s).filter((x) => x.mm > 2.5)
	assert.deepEqual(far, [])
	for (const ref of ["C7", "C8", "C19", "C20"]) assert.ok(offBox(s).some((x) => x.cap === ref), ref)
	// Every pin 1 within reach (the fix this pins); a ground return just past it (pin 2, checked since 26 Nov 2026) sends
	// the board to Freerouting, not to a failed tscircuit build.
	assert.deepEqual(unreachableCaps(s).filter((m) => /\.pin1 /.test(m)), [])
})

test("the placement check (unreachableCaps) holds back no fixture's layout; on run 21 before the fix it gave 17.61/13.53/30.19/15.48 mm where tscircuit said 17.32/13.20/30.04/15.50", () => {
	// No board fixture is held back by the check (it only skips layouts tscircuit would refuse).
	const outOfReach: string[] = []
	for (const f of readdirSync(D).filter((x) => x.endsWith(".json"))) {
		let s: ContractSnapshot
		try { s = fx(f); if (!s.values?.parts || !s.values?.outline) continue } catch { continue }
		// The plain layout, or else the one with the pin parts beside their pins (pinPads, tried after it, board.ts).
		let far: string[] = []
		try { far = unreachableCaps(s); if (far.length) far = unreachableCaps(s, { pinPads: true }) } catch { continue }
		if (far.length) outOfReach.push(f)
	}
	// Until 26 Nov 2026 four boards (both eurobots, the rover mock) left a capacitor 5.08-7.58 mm out on every layout; with
	// pin capacitors' reserved spots kept free for them (CNC mock 8), their pinPads layout reaches all. A name here is a
	// placement regression.
	assert.deepEqual(outOfReach.sort(), [])
})

test("the reach check and tscircuit use one bound: no generous margin, and no fixture's pin capacitor it can't measure", async () => {
	const { CAP_REACH_MARGIN_MM, capsUnchecked } = await import("../src/codegen/circuit.ts")
	assert.ok(CAP_REACH_MARGIN_MM <= 0)
	const skipped: string[] = []
	for (const f of readdirSync(D).filter((x) => x.endsWith(".json"))) {
		let s: ContractSnapshot
		try { s = fx(f); if (!s.values?.parts || !s.values?.outline) continue } catch { continue }
		try { skipped.push(...capsUnchecked(s).map((c) => `${f}: ${c}`)) } catch { continue }
	}
	assert.deepEqual(skipped, [])
})

test("both ends of a pin capacitor are checked: a rover's IMU capacitor reached on pin 1 and was refused on pin 2 to U6.GND", () => {
	const s = fx("rover-mock-rev11.json")
	const far = unreachableCaps(s)
	// tscircuit refused this layout for ".U6 > .GND to .C8 > .pin2 ... 5.01mm" (rover mock, 26 Nov 2026).
	assert.ok(far.some((m) => /U6 > \.GND to \.C8 > \.pin2/.test(m)), far.join("; "))
	assert.ok(far.some((m) => /U6 > \.VDD to \.C8 > \.pin1/.test(m)), far.join("; "))
})
