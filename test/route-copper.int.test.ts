import { test } from "node:test"
import assert from "node:assert/strict"
import { copyFileSync, cpSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ROOT } from "../src/run.ts"
import { detectEnvironment, KICAD_IMAGE } from "../src/tools/env.ts"
import { mount } from "../src/tools/mount.ts"
import { run } from "../src/tools/exec.ts"
import { tempDir } from "./helpers.ts"
import { netCopper } from "../src/tools/track-widths.ts"
import { writeFileSync } from "node:fs"

const env = await detectEnvironment(ROOT)
const uid = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`

// The arm board (25 Nov 2026) came back from Freerouting with 499 "zone clearance 0.15 mm, actual 0" errors: the pours
// were handed to Freerouting as planes and routed over, but their fill was the one tscircuit drew before any track, and
// nothing refilled it. freeroute.py now refills after the session import; this checks that step on a board whose pour
// was filled before a track of another net crossed it.
test("a pour filled before the routing is refilled around the new track: its zone clearance errors go", { skip: !env.kicad && "the kicad docker image is missing", timeout: 300_000 }, async () => {
	const dir = tempDir()
	cpSync(join(ROOT, "test/data/drc-j1"), dir, { recursive: true })
	copyFileSync(join(ROOT, "test/data/stale-pour.py"), join(dir, "stale-pour.py"))
	copyFileSync(join(ROOT, "py/freeroute.py"), join(dir, "freeroute.py"))
	const script = [
		"python3 stale-pour.py board.kicad_pcb stale.kicad_pcb",
		"python3 freeroute.py refill stale.kicad_pcb fixed.kicad_pcb",
		"for b in stale fixed; do cp board.kicad_pro $b.kicad_pro; kicad-cli pcb drc --format json -o $b.json $b.kicad_pcb >/dev/null; done",
	].join(" && ")
	const r = await run("docker", ["run", "--rm", "-u", uid, "-e", "HOME=/tmp", "-v", mount(dir, "/w"), "-w", "/w", KICAD_IMAGE, "sh", "-c", script], { timeoutMs: 280_000 })
	assert.equal(r.code, 0, r.stderr)
	const zoneClearance = (b: string) => (JSON.parse(readFileSync(join(dir, `${b}.json`), "utf8")).violations as { description: string }[]).filter((v) => /zone clearance/.test(v.description)).length
	assert.ok(zoneClearance("stale") >= 1, "the stale board shows the bug")
	assert.equal(zoneClearance("fixed"), 0)
})

// Option c (lead-2, 26 Nov 2026): a rail routed at the default track is widened afterwards where clearance allows. On the
// logger board (DRC-clean), VBUS asked for 1 mm: where there is room it widens, none of it crosses another net's clearance.
test("a wide net is widened after routing where there is room, never into another net's clearance", { skip: !env.kicad && "the kicad docker image is missing", timeout: 300_000 }, async () => {
	const dir = tempDir()
	cpSync(join(ROOT, "test/data/drc-j1"), dir, { recursive: true })
	copyFileSync(join(ROOT, "py/freeroute.py"), join(dir, "freeroute.py"))
	writeFileSync(join(dir, "widths.json"), JSON.stringify({ VBUS: 1 }))
	const script = [
		"python3 freeroute.py widen board.kicad_pcb wide.kicad_pcb widths.json 0.15 0.35",
		"cp board.kicad_pro wide.kicad_pro",
		"kicad-cli pcb drc --format json -o wide.json wide.kicad_pcb >/dev/null",
	].join(" && ")
	const r = await run("docker", ["run", "--rm", "-u", uid, "-e", "HOME=/tmp", "-v", mount(dir, "/w"), "-w", "/w", KICAD_IMAGE, "sh", "-c", script], { timeoutMs: 280_000 })
	assert.equal(r.code, 0, r.stderr)
	// Wider than the routed 0.2 mm where there was room (the small logger has little room for a full 1 mm).
	const before = netCopper(readFileSync(join(dir, "board.kicad_pcb"), "utf8"), new Map([["VBUS", 0.25]]))[0]
	const after = netCopper(readFileSync(join(dir, "wide.kicad_pcb"), "utf8"), new Map([["VBUS", 0.25]]))[0]
	assert.equal(before.atWidthMm, 0)
	assert.ok(after.atWidthMm > 0, JSON.stringify(after))
	assert.ok(Math.abs(after.totalMm - before.totalMm) < 0.01, "the same track, only wider")
	const v = JSON.parse(readFileSync(join(dir, "wide.json"), "utf8")).violations as { type: string; items: { description: string }[] }[]
	assert.equal(v.filter((x) => x.type === "clearance").length, 0)
	// Nor into a hole's clearance (J1's unplated locating holes sit by VBUS).
	assert.equal(v.filter((x) => x.type === "hole_clearance" && x.items.some((i) => /\[VBUS\]/.test(i.description))).length, 0)
})
