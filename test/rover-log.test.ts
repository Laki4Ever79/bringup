// The bench companion's log reading (src/bench/rover-log.ts): every recorded simulated drive log (healthy) gives no
// finding; each rule fires on a log that shows it, with the line quoted, and stays quiet on a near miss.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { diagnoseRoverLog, findingsText, parseRoverLog } from "../src/bench/rover-log.ts"

const ROOT = resolve(import.meta.dirname, "..")
const BOOT = "ESP-ROM:esp32c3-api1-20210207\nBuild:Feb  7 2021\nrst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT)\n"
const kinds = (log: string, sim?: string) => diagnoseRoverLog(parseRoverLog(log), sim ? parseRoverLog(sim) : null).map((f) => f.kind)

function uarts(dir: string, out: string[] = [], depth = 0): string[] {
	if (!existsSync(dir) || depth > 5) return out
	for (const n of readdirSync(dir)) {
		const p = join(dir, n)
		try { if (statSync(p).isDirectory()) uarts(p, out, depth + 1); else if (n === "uart0.txt") out.push(p) } catch {}
	}
	return out
}

// Healthy: the drives that passed (drive.json). A drive that never ran (its firmware didn't answer) isn't, and the
// never-ready rule rightly fires on it (out/20261120-220257 rev 14 and 17, 26 Nov 2026).
const passed = (f: string) => { try { return JSON.parse(readFileSync(join(f, "..", "drive.json"), "utf8")).result === "pass" } catch { return false } }
test("every recorded simulated drive log of a drive that passed is healthy: no finding fires", () => {
	const logs = uarts(join(ROOT, "out")).filter(passed)
	if (!logs.length) return
	const fired = logs.flatMap((f) => { const k = kinds(readFileSync(f, "utf8")); return k.length ? [`${f}: ${k.join(", ")}`] : [] })
	assert.deepEqual(fired, [], `${fired.length} of ${logs.length} healthy logs fired`)
})

test("the parser reads the firmware's lines: boots, ready, R with encoders and heading, ODO, GOTO, a panic", () => {
	const l = parseRoverLog(`${BOOT}ROVER ready\nR 120 340 0.500 0.500 E 10 12 H -15\nODO 500 12.5 -3.0 0.020\nGOTO done 593.3 0.1 (target 600.0 0.0)\nGuru Meditation Error: Core  0 panic'ed (LoadProhibited)\n`)
	assert.deepEqual(l.boots.map((b) => b.reason), ["POWERON"])
	assert.deepEqual(l.ready, [4])
	assert.deepEqual(l.r[0], { ms: 120, distMm: 340, dutyL: 0.5, dutyR: 0.5, enc: [10, 12], headingMrad: -15, line: 5 })
	assert.deepEqual(l.odo[0], { ms: 500, x: 12.5, y: -3, th: 0.02 })
	assert.equal(l.gotos[0].tx, 600)
	assert.equal(l.panics.length, 1)
})

test("brownout: a reset for low supply mid-run fires, quoted; a power-on boot alone doesn't", () => {
	const log = `${BOOT}ROVER ready\nODO 500 0.0 0.0 0.000\n${BOOT.replace("0x1 (POWERON)", "0xf (BROWNOUT_RST)")}ROVER ready\n`
	const f = diagnoseRoverLog(parseRoverLog(log), parseRoverLog(`${BOOT}ROVER ready\n`))
	assert.deepEqual(f.map((x) => x.kind), ["brownout"])
	assert.match(f[0].evidence[0], /^line 8: rst:0xf \(BROWNOUT_RST\)/)
	assert.match(f[0].simulated!, /booted 1 time, with no brownout/)
	assert.deepEqual(kinds(`${BOOT}ROVER ready\n`), [])
})

test("crash: a panic or a watchdog reset fires; a software restart after flashing alone doesn't (one boot)", () => {
	assert.deepEqual(kinds(`${BOOT}ROVER ready\nGuru Meditation Error: Core  0 panic'ed (LoadProhibited)\n`), ["crash"])
	assert.deepEqual(kinds(`${BOOT}ROVER ready\n${BOOT.replace("0x1 (POWERON)", "0x7 (TG0WDT_SYS_RST)")}ROVER ready\n`), ["crash"])
	assert.deepEqual(kinds(`${BOOT.replace("0x1 (POWERON)", "0xc (SW_CPU_RST)")}ROVER ready\n`), [], "the first boot's reason is how it started, not a crash")
})

test("never ready: booted and no ROVER ready; a log cut before boot doesn't fire", () => {
	assert.deepEqual(kinds(`${BOOT}E (312) i2c: i2c driver install error\n`), ["never-ready"])
	assert.deepEqual(kinds(`ESP-ROM:esp32c3-api1-20210207\n`), [])
})

test("sensor silent: -1 in over 80 % of 20+ readings fires; a sensor that sees nothing now and then doesn't", () => {
	const rs = (n: number, bad: number) => Array.from({ length: n }, (_, i) => `R ${i * 50} ${i < bad ? -1 : 300} 0.400 0.400`).join("\n")
	assert.deepEqual(kinds(`${BOOT}ROVER ready\n${rs(30, 28)}\n`), ["sensor-silent"])
	assert.deepEqual(kinds(`${BOOT}ROVER ready\n${rs(30, 10)}\n`), [])
	assert.deepEqual(kinds(`${BOOT}ROVER ready\n${rs(10, 10)}\n`), [], "too few readings to say")
})

test("wheels mismatched: 8 % or more fewer counts at equal duty fires, naming the slow wheel; 3 % doesn't", () => {
	const drive = (l: number, r: number) => Array.from({ length: 20 }, (_, i) => `R ${i * 50} 400 0.500 0.500 E ${i * l} ${i * r}`).join("\n")
	const f = diagnoseRoverLog(parseRoverLog(`${BOOT}ROVER ready\n${drive(18, 20)}\n`))
	assert.deepEqual(f.map((x) => x.kind), ["wheels-mismatched"])
	assert.match(f[0].says, /the left wheel turned 10 % less/)
	assert.deepEqual(kinds(`${BOOT}ROVER ready\n${drive(20, 20.6)}\n`), [])
	// Turning on purpose (unequal duties) never counts.
	assert.deepEqual(kinds(`${BOOT}ROVER ready\n${Array.from({ length: 20 }, (_, i) => `R ${i * 50} 400 0.200 0.600 E ${i * 6} ${i * 20}`).join("\n")}\n`), [])
})

test("go-to short: ending over 30 mm from its target by its own count fires; the recorded lap's 4.8 mm doesn't", () => {
	assert.deepEqual(kinds(`${BOOT}ROVER ready\nGOTO done 420.0 280.0 (target 500.0 300.0)\n`), ["goto-short"])
	assert.deepEqual(kinds(`${BOOT}ROVER ready\nGOTO done 4.8 399.7 (target 0.0 400.0)\n`), [])
	assert.match(findingsText(diagnoseRoverLog(parseRoverLog(`${BOOT}ROVER ready\n`))), /^Nothing in this log points at a problem/)
})
