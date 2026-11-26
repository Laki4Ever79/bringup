// The arm's firmware (templates/fw-arm, src/arm/firmware.ts armHeader; arm task 7): the generated header's values, and
// the firmware's own C logic run on the host: IK, the move profile, the pick plan and the PCA9685 bytes.
import { after, test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ARM, TARGETS } from "./arm-contract.test.ts"
import { INSIDE, OUT, armContract } from "./arm-fixture.ts"
import { armHeader, ARM_SPEED_SHARE } from "../src/arm/firmware.ts"
import { prepareFirmware } from "../src/tools/firmware.ts"
import type { ArmSpec, ArmTargets } from "../src/arm/types.ts"

const root = new URL("..", import.meta.url).pathname

// The firmware folder as a run prepares it, and the harness built against it.
const harness = new Map<ArmTargets, string>()
const dirs: string[] = []
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))
async function build(targets: ArmTargets = INSIDE): Promise<string> {
	if (harness.has(targets)) return harness.get(targets)!
	const dir = mkdtempSync(join(tmpdir(), "arm-fw-"))
	dirs.push(dir)
	await prepareFirmware(root, dir, armContract(ARM, targets))
	const bin = join(dir, "harness")
	execFileSync("cc", ["-O1", "-I", join(dir, "include"), "-I", join(dir, "src"), "-o", bin, join(root, "test/fixtures/arm-harness.c"), ...["ik.c", "traj.c", "pick.c", "servo_map.c"].map((f) => join(dir, "src", f)), "-lm"])
	harness.set(targets, bin)
	return bin
}
async function ask<T = Record<string, unknown>>(lines: string[], targets?: ArmTargets): Promise<T[]> {
	const r = spawnSync(await build(targets), { input: lines.join("\n") + "\n", encoding: "utf8" })
	assert.equal(r.status, 0, r.stderr)
	return r.stdout.trim().split("\n").map((l) => JSON.parse(l) as T)
}

test("header values come from the contract", () => {
	const h = armHeader(armContract())
	assert.match(h, /#define I2C_SDA 8\n#define I2C_SCL 9/)
	assert.match(h, /#define ARM_REPEATS 5/)
	assert.match(h, /ARM_CHANNEL\[ARM_NS\] = \{0, 1, 2, 3, 4, 5\}/)
	// MG996R 0.14 s/60° and SG90 0.10 s/60° at 6 V, × 0.8.
	const mg = (60 / 0.14) * ARM_SPEED_SHARE, sg = (60 / 0.1) * ARM_SPEED_SHARE
	assert.ok(h.includes(`ARM_DEG_PER_S[ARM_NS] = {${[mg, mg, mg, sg, sg, sg].map((n) => `${Number(n.toFixed(3))}f`.replace(/^(-?\d+)f$/, "$1.0f")).join(", ")}}`), h)
	// Geometry: no yaw offset, shoulder 60 mm up, links 120 and 110, wrist 20 + 30; pick and drop from armTargets.
	assert.match(h, /#define ARM_TASK \{ \{0\.0f, 60\.0f, 120\.0f, 110\.0f, 50\.0f, /)
	assert.match(h, /\{150\.0f, -100\.0f, 20\.0f\}, \{150\.0f, 100\.0f, 60\.0f\}/)
	assert.throws(() => armHeader({ ...armContract(), values: { ...armContract().values, armTargets: undefined } }), /no arm or armTargets/)
	assert.throws(() => armHeader(armContract({ ...ARM, railV: 7.4 })), /is rated 4\.8–[0-9.]+ V, not 7\.4 V/)
	assert.throws(() => armHeader(armContract({ ...ARM, gripper: { ...ARM.gripper, servo: "STS3215 C001 7.4V" } })), /phase 2/)
})

test("PCA9685 bytes: deg → counts against the datasheet's PRE_SCALE and LEDn_ON/OFF", async () => {
	// Shoulder (MG996R, 120° travel, 1000–2000 us) at 60°: the middle of its 0..120 range → 1500 us.
	const [r] = await ask<{ prescale50: number; prescale200: number; reg: number; servoDeg: number; us: number; bytes: number[] }>(["pca 1 60"])
	assert.equal(r.prescale200, 30, "the datasheet's example: 200 Hz → 0x1E")
	assert.equal(r.prescale50, 121) // round(25 MHz / (4096 × 50)) − 1
	assert.equal(r.reg, 0x06 + 4 * 1, "LED1_ON_L")
	assert.equal(r.us, 1500)
	assert.deepEqual(r.bytes, [0, 0, 307 & 0xff, 307 >> 8], "ON at 0, OFF at 1500 us × 4096 × 50 Hz = 307")
	// The wrist pitch (SG90, 180° of travel) spans -120..90, 210°: centred, its ends fall 15° past the servo's, so -90
	// lands at 15° of travel: 1000 + 1000 × 15/180 = 1083 us. (A joint range over the servo's travel: clamped here.)
	const [w] = await ask<{ us: number; servoDeg: number }>(["pca 3 -90"])
	assert.equal(w.servoDeg, 15)
	assert.equal(w.us, 1083)
	const [lo] = await ask<{ servoDeg: number }>(["pca 3 -120"])
	assert.equal(lo.servoDeg, 0, "clamped to the servo's travel")
})

// Grip points made by the forward kinematics of joint angles inside the limits with the gripper down.
function reachable(n: number): number[][] {
	let seed = 7
	const rnd = (a: number, b: number) => ((seed = (seed * 16807) % 2147483647), a + ((b - a) * seed) / 2147483647)
	const out: number[][] = []
	const by = (name: string) => ARM.joints.find((j) => j.name === name)!
	while (out.length < n) {
		const yaw = rnd(by("base-yaw").minDeg, by("base-yaw").maxDeg), sh = rnd(by("shoulder").minDeg, by("shoulder").maxDeg), el = rnd(by("elbow").minDeg, by("elbow").maxDeg)
		const wr = -90 - sh - el
		if (wr < by("wrist-pitch").minDeg || wr > by("wrist-pitch").maxDeg) continue
		out.push([yaw, sh, el, wr, 0])
	}
	return out
}

test("IK: forward∘solve returns the point within 0.1 mm on 50 reachable points; unreachable gives the shortfall, no NaN", async () => {
	const qs = reachable(50)
	const pts = (await ask<{ p: number[] }>(qs.map((q) => `forward ${q.join(" ")}`))).map((r) => r.p)
	const sol = await ask<{ r: number; q: number[] }>(pts.map((p) => `solve ${p.join(" ")}`))
	const back = await ask<{ p: number[] }>(sol.map((s) => `forward ${s.q.join(" ")}`))
	sol.forEach((s, i) => {
		assert.equal(s.r, 0, `point ${pts[i]}`)
		assert.ok(Math.hypot(...back[i].p.map((v, k) => v - pts[i][k])) < 0.1, `${pts[i]} → ${back[i].p}`)
	})
	// 400 mm out: past the 230 mm of shoulder + elbow links.
	const [far] = await ask<{ r: number; short: number; q: number[] }>(["solve 400 0 20"])
	assert.equal(far.r, 1)
	assert.ok(far.short > 100 && far.short < 200, `${far.short}`)
	assert.ok(far.q.every(Number.isFinite))
})

// Arm task 2's solve (src/arm/kinematics.ts): the firmware must agree with it within 0.1° on the same 50 points.
const kinematics = join(root, "src/arm/kinematics.ts")
test("IK agrees with src/arm/kinematics.ts solve within 0.1°", { skip: existsSync(kinematics) ? false : "arm task 2 (src/arm/kinematics.ts) not merged yet" }, async () => {
	const { solve } = (await import(kinematics)) as { solve: (arm: ArmSpec, at: { xMm: number; yMm: number; zMm: number }, down?: boolean) => number[] | { error: string } }
	const pts = (await ask<{ p: number[] }>(reachable(50).map((q) => `forward ${q.join(" ")}`))).map((r) => r.p)
	const fw = await ask<{ r: number; q: number[] }>(pts.map((p) => `solve ${p.join(" ")}`))
	pts.forEach((p, i) => {
		const ts = solve(ARM, { xMm: p[0], yMm: p[1], zMm: p[2] }, true)
		assert.ok(Array.isArray(ts), `TS solve failed at ${p}: ${JSON.stringify(ts)}`)
		ts.forEach((d, k) => assert.ok(Math.abs(d - fw[i].q[k]) < 0.1, `joint ${k} at ${p}: ${d} vs ${fw[i].q[k]}`))
	})
})

test("moves: all servos arrive together, none over its speed limit", async () => {
	const limits = [...Array(3).fill((60 / 0.14) * ARM_SPEED_SHARE), ...Array(3).fill((60 / 0.1) * ARM_SPEED_SHARE)]
	const [m] = await ask<{ dur: number; peak: number[]; end: number[] }>(["move 0 10 -20 -80 0 0 60 90 -100 -80 45 90"])
	m.peak.forEach((p, i) => assert.ok(p <= limits[i] * 1.01, `servo ${i}: ${p} deg/s over ${limits[i]}`))
	assert.deepEqual(m.end.map((x) => Math.round(x * 100) / 100), [60, 90, -100, -80, 45, 90])
	// The slowest is the base or shoulder (80° at 342.9 deg/s = 0.233 s), plus one 0.15 s ramp.
	assert.ok(Math.abs(m.dur - (80 / limits[0] + 0.15)) < 1e-3, `${m.dur}`)
	const [still] = await ask<{ dur: number }>(["move 1 2 3 4 5 6 1 2 3 4 5 6"])
	assert.equal(still.dur, 0)
})

test("pick plan: 8 waypoints per cycle, gripper open to grip and closed to carry", async () => {
	const [p] = await ask<{ n: number; approach: number; w: { deg: number[]; hold: number }[] }>(["plan"])
	assert.equal(p.n, 8, JSON.stringify(p))
	assert.ok(p.approach >= 0 && p.approach <= 40)
	const grip = p.w.map((w) => w.deg[5])
	assert.deepEqual(grip, [90, 90, 0, 0, 0, 0, 90, 90])
	assert.deepEqual(p.w.map((w) => w.hold > 0), [false, false, true, false, false, false, true, false])
	// The pick waypoint's grip point is the brief's pick point.
	const [tip] = await ask<{ p: number[] }>([`forward ${p.w[1].deg.slice(0, 5).join(" ")}`])
	assert.ok(Math.hypot(tip.p[0] - 150, tip.p[1] + 100, tip.p[2] - 20) < 0.1, `${tip.p}`)
	assert.equal(p.approach, 40)
	// The brief's own points (the fixture's TARGETS, which arm-reach passes): a full plan at the full approach.
	const [demo] = await ask<{ n: number; approach: number }>(["plan"], TARGETS)
	assert.deepEqual([demo.n, demo.approach], [8, 40])
	// A drop out of reach: no plan, which the firmware reports instead of moving.
	const [no] = await ask<{ n: number }>(["plan"], OUT)
	assert.equal(no.n, -1)
})
