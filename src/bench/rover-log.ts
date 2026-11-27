// The bench companion's first piece (design note 2026-11-26-bench-companion-design.md): a rover's serial log read
// the same way whether it came from the real robot over USB or from the simulation (drive/rev-N/uart0.txt), and plain
// findings from it. A finding fires only on lines that show it, and quotes them; nothing is guessed. The firmware's
// lines (templates/fw-rover/src/main.cpp): the ESP32's boot banner ("rst:0x.. (REASON)"), "ROVER ready",
// "R <ms> <mm> <dutyL> <dutyR>[ E <encL> <encR>][ H <mrad>]" (while a host drives it), "ODO <ms> <x> <y> <th>",
// "GOTO done <x> <y> (target <tx> <ty>)", "CAL start|turned|coast …", and a panic's "Guru Meditation Error".

export interface RLine { ms: number; distMm: number; dutyL: number; dutyR: number; enc: [number, number] | null; headingMrad: number | null; line: number }
export interface RoverLog {
	boots: { reason: string; line: number; text: string }[]
	ready: number[]
	r: RLine[]
	odo: { ms: number; x: number; y: number; th: number; line: number }[]
	// "HOLD <ms> <mm>": the distance it reads while holding still (no host driving it).
	hold: { ms: number; distMm: number; line: number }[]
	// The turn calibration (C): "CAL start <ms> <quarters>", "CAL turned ccw <ms> <rad>", "CAL turned cw <ms> <rad> scale
	// <s>", "CAL coast <ms> <mm>": what the robot counted, by its own wheels.
	cals: { kind: "start" | "ccw" | "cw" | "coast"; ms: number; value: number; scale?: number; line: number }[]
	// Commands sent to it during a bench session ("> G 500 300" in the session's text, serial-stream.ts sessionText).
	sent: { cmd: string; line: number }[]
	gotos: { x: number; y: number; tx: number; ty: number; line: number; text: string }[]
	panics: { line: number; text: string }[]
	lines: number
}

export function parseRoverLog(text: string): RoverLog {
	const out: RoverLog = { boots: [], ready: [], r: [], odo: [], hold: [], cals: [], sent: [], gotos: [], panics: [], lines: 0 }
	const ls = text.split(/\r?\n/)
	out.lines = ls.length
	ls.forEach((raw, i) => {
		const l = raw.trim()
		const n = i + 1
		let m: RegExpExecArray | null
		if ((m = /^rst:0x[0-9a-f]+ \(([A-Z0-9_]+)\)/i.exec(l))) out.boots.push({ reason: m[1].toUpperCase(), line: n, text: l })
		else if (l === "ROVER ready") out.ready.push(n)
		else if ((m = /^R (\d+) (-?\d+) (-?[\d.]+) (-?[\d.]+)(?: E (-?\d+) (-?\d+))?(?: H (-?\d+))?$/.exec(l)))
			out.r.push({ ms: +m[1], distMm: +m[2], dutyL: +m[3], dutyR: +m[4], enc: m[5] !== undefined ? [+m[5], +m[6]] : null, headingMrad: m[7] !== undefined ? +m[7] : null, line: n })
		else if ((m = /^ODO (\d+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)$/.exec(l))) out.odo.push({ ms: +m[1], x: +m[2], y: +m[3], th: +m[4], line: n })
		else if ((m = /^HOLD (\d+) (-?\d+)$/.exec(l))) out.hold.push({ ms: +m[1], distMm: +m[2], line: n })
		else if ((m = /^CAL start (\d+) (\d+)$/.exec(l))) out.cals.push({ kind: "start", ms: +m[1], value: +m[2], line: n })
		else if ((m = /^CAL turned (ccw|cw) (\d+) (-?[\d.]+)(?: scale (-?[\d.]+))?$/.exec(l))) out.cals.push({ kind: m[1] as "ccw" | "cw", ms: +m[2], value: +m[3], ...(m[4] !== undefined ? { scale: +m[4] } : {}), line: n })
		else if ((m = /^CAL coast (\d+) (-?[\d.]+)$/.exec(l))) out.cals.push({ kind: "coast", ms: +m[1], value: +m[2], line: n })
		else if ((m = /^> (.+)$/.exec(l))) out.sent.push({ cmd: m[1], line: n })
		else if ((m = /^GOTO done (-?[\d.]+) (-?[\d.]+) \(target (-?[\d.]+) (-?[\d.]+)\)$/.exec(l))) out.gotos.push({ x: +m[1], y: +m[2], tx: +m[3], ty: +m[4], line: n, text: l })
		else if (/Guru Meditation Error|abort\(\) was called|Backtrace:/.test(l)) out.panics.push({ line: n, text: l })
	})
	return out
}

export interface Finding {
	kind: "brownout" | "crash" | "never-ready" | "sensor-silent" | "wheels-mismatched" | "goto-short"
	says: string
	// What to look at or change, plainly; a change request the person can send when the fix is in the design.
	next: string
	request?: string
	evidence: string[]
	// The same from the simulated drive of this revision, when there is one (null: not compared).
	simulated: string | null
}

const BROWNOUT = new Set(["BROWNOUT_RST", "RTC_BROWNOUT_RST"])
const CRASH = new Set(["TG0WDT_SYS_RST", "TG1WDT_SYS_RST", "RTCWDT_SYS_RST", "RTCWDT_RTC_RST", "TG0WDT_CPU_RST", "SW_CPU_RST", "RTCWDT_CPU_RST", "SUPER_WDT_RST"])

// Findings from a real log, each checked against the simulated one (sim: the same revision's uart0.txt, or null).
export function diagnoseRoverLog(real: RoverLog, sim: RoverLog | null = null): Finding[] {
	const f: Finding[] = []
	const ln = (n: number, t: string) => `line ${n}: ${t}`
	const resets = real.boots.slice(1)
	const brown = resets.filter((b) => BROWNOUT.has(b.reason))
	if (brown.length)
		f.push({ kind: "brownout", says: `It reset ${brown.length} time${brown.length > 1 ? "s" : ""} from a brownout: the supply dipped below what the chip needs, typically when the motors start`, next: "Look at the 3.3 V rail when the motors start: a bigger bulk capacitor at the regulator, the motor driver's supply wired straight from the battery, and a charged pack", evidence: brown.map((b) => ln(b.line, b.text)), simulated: sim ? `the simulation booted ${sim.boots.length} time${sim.boots.length === 1 ? "" : "s"}, with no brownout` : null })
	const crash = [...resets.filter((b) => CRASH.has(b.reason)).map((b) => ln(b.line, b.text)), ...real.panics.map((p) => ln(p.line, p.text))]
	if (crash.length)
		f.push({ kind: "crash", says: "The program crashed or a watchdog reset it", next: "Read the lines around it for the cause (the backtrace's addresses map to the firmware with addr2line); the design's firmware build is in firmware/rev-N", evidence: crash.slice(0, 4), simulated: sim ? (sim.panics.length ? "the simulation crashed too: it's in the program, not the hardware" : "the simulation ran without a crash: look at what differs on the real board (wiring, power, a sensor that answers differently)") : null })
	if (real.boots.length && !real.ready.length)
		f.push({ kind: "never-ready", says: "It booted but never said “ROVER ready”: the program stopped before its loop", next: "A missing sensor or a wrong pin at start-up is the usual cause; compare the wiring with the design's pin map", evidence: real.boots.slice(0, 2).map((b) => ln(b.line, b.text)), simulated: sim ? (sim.ready.length ? "the simulation reached “ROVER ready”" : "the simulation didn't either") : null })
	const reads = real.r.filter((r) => r.distMm !== undefined)
	const silent = reads.filter((r) => r.distMm < 0)
	if (reads.length >= 20 && silent.length / reads.length > 0.8)
		f.push({ kind: "sensor-silent", says: `The distance sensor read nothing (-1) in ${Math.round((silent.length / reads.length) * 100)} % of ${reads.length} readings`, next: "Check its cable and its I2C address; nothing in range also reads -1, so test it with a hand 20 cm in front", evidence: silent.slice(0, 2).map((r) => ln(r.line, `R ${r.ms} ${r.distMm} …`)), simulated: null })
	// Wheels at the same duty: count deltas over stretches where both duties are equal and well above stall.
	let dl = 0, dr = 0, span = 0
	for (let i = 1; i < real.r.length; i++) {
		const a = real.r[i - 1], b = real.r[i]
		if (!a.enc || !b.enc || Math.abs(a.dutyL - a.dutyR) > 0.02 || Math.abs(a.dutyL) < 0.25 || Math.sign(a.dutyL) !== Math.sign(a.dutyR)) continue
		dl += Math.abs(b.enc[0] - a.enc[0]); dr += Math.abs(b.enc[1] - a.enc[1]); span++
	}
	if (span >= 10 && dl + dr > 200) {
		const ratio = dl / Math.max(1, dr)
		if (Math.abs(ratio - 1) >= 0.08) {
			const slow = ratio < 1 ? "left" : "right", pct = Math.round(Math.abs(1 - Math.min(ratio, 1 / ratio)) * 100)
			f.push({ kind: "wheels-mismatched", says: `At the same duty the ${slow} wheel turned ${pct} % less (${dl} against ${dr} counts over ${span} readings)`, next: `A ${slow} motor or gearbox that drags (check it turns freely), a loose wheel, or a motor lead with a bad crimp; until then it curves ${slow === "left" ? "left" : "right"} on a straight`, evidence: [ln(real.r[0].line, "first equal-duty reading"), `${span} readings at equal duty`], simulated: "the simulated wheels match by construction" })
		}
	}
	for (const g of real.gotos) {
		const miss = Math.hypot(g.x - g.tx, g.y - g.ty)
		if (miss > 30) f.push({ kind: "goto-short", says: `A go-to ended ${Math.round(miss)} mm from its target by the robot's own count: something stopped it (the obstacle guard, or a wheel slipping)`, next: "Clear its path and try again; if it stops short in the open, look at the distance sensor's readings near the end", evidence: [ln(g.line, g.text)], simulated: sim?.gotos.length ? `the simulated go-to ended ${Math.round(Math.hypot(sim.gotos[0].x - sim.gotos[0].tx, sim.gotos[0].y - sim.gotos[0].ty))} mm from its target` : null })
	}
	return f
}

export function findingsText(f: Finding[]): string {
	if (!f.length) return "Nothing in this log points at a problem. (Checked where the log shows them: resets and crashes, start-up, the distance sensor, the wheels at equal duty, go-tos.)"
	return f.map((x, i) => `${i + 1}. ${x.says}.\n   Next: ${x.next}.${x.simulated ? `\n   Simulation: ${x.simulated}.` : ""}\n   From the log: ${x.evidence.join(" · ")}${x.request ? `\n   Change: ${x.request}` : ""}`).join("\n\n")
}
