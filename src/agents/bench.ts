import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createHuman, type Human } from "@mozaik-ai/core"
import { proposeHeld, when } from "../change-control.ts"
import { batteryLifeDays, effectiveSleepUa, estimatePower, measuredAverageMa } from "../contract/power.ts"
import type { ContractSnapshot, Rail } from "../contract/types.ts"
import { isEvent, makeEvent, type BenchCheck, type BenchSample, type BenchSourceName, type Payloads } from "../events.ts"
import { measureCycles, worthProposing, type MeterSample } from "../bench/measure.ts"
import { emit, state } from "../runtime.ts"
import type { Bridge, BridgeHello, BridgeLine } from "../tools/bench-bridge.ts"
import { Rebuilder } from "../tools/rebuilder.ts"

// GPIOs the bench wiring uses on the S3 (bench.md §1): BENCH_MODE in from the fixture, telemetry UART1 TX out.
export const BENCH_PINS: Record<number, string> = { 4: "BENCH_MODE", 17: "UART1 TX" }

export const BENCH_ENV = "esp32s3_bench"
// Boot reasons that mean the firmware crashed or the supply sagged (bench.md §3b).
const CRASH_RESETS = new Set(["panic", "wdt", "brownout"])
const DIALOUT_FIX = "add yourself to dialout (sudo usermod -aG dialout $USER, then log in again) or install udev/99-bench.rules"

export interface BenchOptions {
	bridge: Bridge
	hello: BridgeHello
	// Duty-cycle measurement window (bench.md: 60 s holds about 15 wakes at BENCH_PERIOD_S = 3).
	windowMs?: number
	// How long to watch live mode for the IMU and the LED after a boot.
	liveCheckMs?: number
	bootTimeoutMs?: number
	batchMs?: number
}

export interface Bench extends Human {
	readonly idle: boolean
	whenIdle(timeoutMs: number): Promise<void>
	close(): Promise<void>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// The rail the 5 V pin's current stands for: the one battery-fed rail (the LDO output feeding the MCU). With more
// than one candidate the measurement can't be attributed, so the bench reports it and proposes nothing.
function measuredRail(rails: Rail[]): Rail | null {
	const fed = rails.filter((r) => !/VBUS|USB/i.test(r.name))
	return fed.length === 1 ? fed[0] : null
}

function sampleOf(line: BridgeLine): BenchSample | null {
	const num = (k: string) => (typeof line[k] === "number" ? { [k]: line[k] as number } : {})
	if (line.k === "i" && typeof line.mA === "number") return { at: line.at, mA: line.mA }
	if (line.k === "s") return { at: line.at, ...num("ax"), ...num("ay"), ...num("az"), ...num("tilt"), ...num("tC"), ...num("led"), ...num("shake") }
	return null
}

// A plain-code participant for bring-up, the post-settle stage (docs/design/bench.md). It talks to the board
// through py/bench.py, flashes the run's firmware after the first design.settled and again on every newer
// firmware build, checks the boot, the IMU and the LED, measures the charge per wake in duty-cycle mode, and
// proposes the measured rail average to the architect through change control. Replays and the fake bench never
// propose; nothing here holds up settling.
export function createBench(opts: BenchOptions): Bench {
	const { bridge, hello } = opts
	const source: BenchSourceName = hello.source
	const windowMs = opts.windowMs ?? 60_000
	const liveCheckMs = opts.liveCheckMs ?? 5_000
	const bootTimeoutMs = opts.bootTimeoutMs ?? 10_000
	const self = { id: "" }
	const send = <T extends keyof Payloads>(type: T, payload: Payloads[T]) => emit(makeEvent(type, self.id, payload), self.id)

	let settledOnce = false
	let bootedRev: number | null = null
	// The revision being flashed (instructions arrive during a flash), and each instruction's text by its id.
	let flashingRev: number | null = null
	const asked = new Map<unknown, string>()
	let latest = -1
	const proposedFor = new Set<number>()
	// Session-scoped line taps (boot waits, live checks, the meter window); telemetry batching sees every line.
	const taps = new Set<(line: BridgeLine) => void>()
	let batch: BenchSample[] = []

	bridge.onLine((line) => {
		if (line.k === "boot" && typeof line.rev === "number") bootedRev = line.rev
		if (line.k === "instruct") {
			const action = String(line.action ?? "")
			if (typeof line.done === "boolean") {
				send("bench.instruction", { revision: flashingRev, action, text: asked.get(line.id) ?? "", state: line.done ? "done" : "timeout" })
				asked.delete(line.id)
			} else {
				asked.set(line.id, String(line.text ?? ""))
				send("bench.instruction", { revision: flashingRev, action, text: String(line.text ?? ""), state: "waiting" })
			}
		}
		const sample = sampleOf(line)
		if (sample) batch.push(sample)
		for (const tap of taps) tap(line)
	})
	const flush = setInterval(() => {
		if (batch.length === 0 || !self.id) return
		const samples = batch
		batch = []
		send("bench.telemetry", { revision: bootedRev, source, samples })
	}, opts.batchMs ?? 250)
	flush.unref()

	// Windows a newer firmware may cut short (the live check, the duty-cycle measurement).
	const cuttable = new Set<() => void>()
	// Collects lines for ms (or until stop returns true, or, if cut, until a newer firmware arrives).
	const collect = async (ms: number, stop?: (line: BridgeLine) => boolean, cut = false): Promise<BridgeLine[]> => {
		const got: BridgeLine[] = []
		let done = false
		await new Promise<void>((resolve) => {
			const tap = (line: BridgeLine) => {
				if (done) return
				got.push(line)
				if (stop?.(line)) finish()
			}
			const finish = () => {
				done = true
				taps.delete(tap)
				cuttable.delete(finish)
				clearTimeout(timer)
				resolve()
			}
			const timer = setTimeout(finish, ms)
			taps.add(tap)
			if (cut) cuttable.add(finish)
		})
		return got
	}

	const flash = async (revision: number, dir: string, snapshot: ContractSnapshot): Promise<{ ok: boolean; simulated: boolean; bootDetail: string; lines: BridgeLine[] }> => {
		const started = Date.now()
		const clash = (snapshot.values.pins ?? []).filter((p) => BENCH_PINS[p.gpio] !== undefined)
		if (clash.length > 0) {
			const error = `the bench wires ${clash.map((p) => `GPIO${p.gpio} (${BENCH_PINS[p.gpio]})`).join(", ")}, but the contract puts ${clash.map((p) => `${p.signal} on GPIO${p.gpio}`).join(", ")}`
			send("bench.flashed", { revision, ok: false, stage: "pins", ms: 0, error })
			return { ok: false, simulated: false, bootDetail: error, lines: [] }
		}
		let lastStage = ""
		let lastPct = -10
		const progress = (line: BridgeLine) => {
			if (line.k !== "flashing") return
			const stage = line.stage as "build" | "connect" | "write"
			const pct = typeof line.pct === "number" ? line.pct : 0
			// Stage changes and 10 % steps, as bench.md asks; the bridge already throttles, this keeps it so.
			if (stage === lastStage && pct - lastPct < 10) return
			lastStage = stage
			lastPct = pct
			send("bench.flashing", { revision, stage, pct })
		}
		taps.add(progress)
		// Everything the board says from the upload on: the boot line, and the first live lines for the checks.
		const after: BridgeLine[] = []
		const afterTap = (line: BridgeLine) => void after.push(line)
		taps.add(afterTap)
		// The ack can take minutes now: the bridge waits for the new firmware to speak, or for the person (bench.instruction).
		flashingRev = revision
		const ack = await bridge.command({ cmd: "flash", dir, env: BENCH_ENV })
		taps.delete(progress)
		if (!ack.ok) {
			taps.delete(afterTap)
			const error = ack.stage === "permission" ? `${ack.error ?? "permission denied"}: ${DIALOUT_FIX}` : (ack.error ?? "flash failed")
			send("bench.flashed", { revision, ok: false, stage: ack.stage ?? "write", ms: ack.ms ?? Date.now() - started, error })
			return { ok: false, simulated: false, bootDetail: error, lines: [] }
		}
		send("bench.flashing", { revision, stage: "boot", pct: 100 })
		const simulated = ack.simulated === true
		// A replay keeps its recorded rev, so any boot line will do; a real board must boot the rev just flashed.
		const matches = (line: BridgeLine) => line.k === "boot" && (simulated || line.rev === revision)
		if (!after.some(matches)) await collect(bootTimeoutMs, matches)
		taps.delete(afterTap)
		const booted = after.find(matches)
		const ms = Date.now() - started
		if (!booted) {
			const other = after.filter((l) => l.k === "boot").at(-1)?.rev
			const error = other !== undefined ? `the board booted rev ${other}, not rev ${revision}: it is running something else` : `no boot line with rev ${revision} within ${bootTimeoutMs / 1000} s`
			send("bench.flashed", { revision, ok: false, stage: "boot", ms, error })
			return { ok: false, simulated, bootDetail: error, lines: [] }
		}
		const lines = after.slice(after.indexOf(booted))
		send("bench.flashed", { revision, ok: true, ms, ...(simulated ? { simulated: true } : {}) })
		return { ok: true, simulated, bootDetail: simulated ? `replay: recorded rev ${booted.rev}` : `booted rev ${revision}`, lines }
	}

	// An IMU line has gravity in it (about 1 g); a board without the MPU-6050 sends zeros.
	const hasGravity = (l: BridgeLine) => l.k === "s" && typeof l.ax === "number" && typeof l.ay === "number" && typeof l.az === "number" && Math.hypot(l.ax, l.ay as number, l.az as number) > 0.3
	const liveChecks = (lines: BridgeLine[]): BenchCheck[] => {
		const imuErr = lines.find((l) => l.k === "err" && l.what === "imu")
		const answered = lines.some(hasGravity)
		const imuOk = !imuErr && answered
		const leds = new Set(lines.filter((l) => l.k === "s" && typeof l.led === "number").map((l) => l.led))
		return [
			// Never answered: not fitted (a bare S3), neutral. Answered, then errors: broken wiring, a failure.
			!answered
				? { name: "imu", pass: true, skipped: true, detail: `not fitted (${imuErr ? String(imuErr.detail ?? "no answer") : "no IMU readings"})` }
				: { name: "imu", pass: imuOk, detail: imuOk ? "the MPU-6050 answers" : `stopped answering: ${imuErr!.detail ?? "error"}` },
			{ name: "led", pass: leds.has(0) && leds.has(1), detail: leds.has(0) && leds.has(1) ? "STATUS_LED toggles" : "the LED did not toggle" },
		]
	}

	const measure = async (revision: number, snapshot: ContractSnapshot): Promise<{ check: BenchCheck | null; measured: Payloads["bench.measured"] | null } | null> => {
		const d = snapshot.values.requirements?.dutyCycle
		const sleepFloor = effectiveSleepUa(snapshot)
		if (!d || !sleepFloor) return null
		// Collect from the moment the command goes out: the wake's boot line can beat the ack.
		const window = collect(windowMs, undefined, true)
		await bridge.command({ cmd: "mode", mode: "duty" })
		const lines = await window
		await bridge.command({ cmd: "mode", mode: "live" })
		// Cut short by a newer firmware: a partial window is no measurement.
		if (latest > revision) return null
		const samples: MeterSample[] = lines.filter((l) => l.k === "i" && typeof l.mA === "number").map((l) => ({ at: l.at, mA: l.mA as number }))
		const m = measureCycles(samples)
		if (!m) return { check: { name: "battery", pass: false, detail: `fewer than 5 complete wakes in ${Math.round(windowMs / 1000)} s` }, measured: null }
		const rail = measuredRail(snapshot.values.rails ?? [])
		const averageMa = measuredAverageMa({ chargeUc: m.chargeUc, periodS: d.periodS, sleepUa: sleepFloor.sleepUa })
		// Battery life with the measured average in place of the rail's.
		const briefPath = join(state().outDir, "brief.md")
		const brief = existsSync(briefPath) ? readFileSync(briefPath, "utf8") : ""
		const withMeasured: ContractSnapshot = rail ? { ...snapshot, values: { ...snapshot.values, rails: snapshot.values.rails!.map((r) => (r.name === rail.name ? { ...r, averageMa } : r)) } } : snapshot
		const e = estimatePower(withMeasured, brief)
		const days = rail && e.capacityMah !== null && e.averageMa !== null ? batteryLifeDays(e.capacityMah, e.averageMa, e.regulatorIqUa) : null
		const target = e.targetDays
		const measured: Payloads["bench.measured"] = {
			revision,
			rail: rail?.name ?? null,
			...m,
			averageMa,
			estimateMa: rail?.averageMa ?? null,
			sleepUa: sleepFloor.sleepUa,
			source,
			days,
			targetDays: target,
			capacityMah: e.capacityMah,
			regulatorIqUa: e.regulatorIqUa,
		}
		// Without a capacity (or a rail to attribute it to) there is nothing to judge: measured, reported, no check.
		const check: BenchCheck | null = days === null ? null : { name: "battery", pass: target === null || days >= target, detail: `${Math.round(days)} days measured${target !== null ? ` vs target ${target}` : ""}` }
		return { check, measured }
	}

	const propose = async (revision: number, measured: Payloads["bench.measured"], snapshot: ContractSnapshot) => {
		// Only measurements of a real board, attributed to one rail, once per firmware revision, and only when they move the number.
		if (source !== "real" || measured.rail === null || proposedFor.has(revision)) return
		const rails = snapshot.values.rails ?? []
		const rail = rails.find((r) => r.name === measured.rail)!
		if (!worthProposing(measured.averageMa, rail.averageMa) || measured.averageMa > rail.loadMa) return
		// A floor near zero means USB powers the board around the shunt, so the awake current is not the board's.
		if (measured.floorMa < 0.5) return
		proposedFor.add(revision)
		const value = rails.map((r) => (r.name === rail.name ? { ...r, averageMa: measured.averageMa, averageSource: "measured" as const, measuredRevision: revision } : r))
		const was = rail.averageMa === undefined ? "no average" : `${rail.averageMa} mA ${rail.averageSource === "measured" ? "measured" : "estimated"}`
		const result = await proposeHeld({
			selfId: self.id,
			role: "bench",
			field: "rails",
			value,
			reason: `measured on the bench at firmware rev ${revision}: ${Number(measured.averageMa.toPrecision(3))} mA average on ${rail.name} (${measured.cycles} wakes, ${Math.round(measured.chargeUc)} µC each), was ${was}`,
		})
		if (result.status !== "applied" && result.status !== "rejected") console.error(`[bench] rails proposal ${result.status}: ${JSON.stringify(result)}`)
	}

	const session = async (revision: number) => {
		const s = state()
		const firmware = s.artifacts.firmware
		// A newer firmware supersedes this one; a firmware that didn't compile can't be flashed.
		if (!firmware?.ok || firmware.revision !== revision || revision < latest) return
		const snapshot = s.contract.snapshot()
		const dir = join(s.outDir, "firmware", `rev-${revision}`)
		const f = await flash(revision, dir, snapshot)
		const checks: BenchCheck[] = [{ name: "boot", pass: f.ok, detail: f.bootDetail }]
		if (f.ok) {
			const live = [...f.lines, ...(await collect(liveCheckMs, undefined, true))]
			const crash = live.find((l) => l.k === "boot" && CRASH_RESETS.has(String(l.reset)))
			if (crash) checks[0] = { name: "boot", pass: false, detail: `booted rev ${revision}, then reset by ${crash.reset}` }
			checks.push(...liveChecks(live))
			if (hello.meter && revision >= latest) {
				const m = await measure(revision, snapshot)
				if (m) {
					if (m.check) checks.push(m.check)
					if (m.measured) {
						send("bench.measured", m.measured)
						void propose(revision, m.measured, snapshot)
					}
				}
			}
		}
		send("bench.verdict", { revision, pass: checks.every((c) => c.pass), source, checks })
	}

	const rebuilder = new Rebuilder(session)
	// The hot loop: a newer firmware cuts the running session's windows short, so it is flashed at once.
	const request = (revision: number) => {
		const newer = revision > latest
		latest = Math.max(latest, revision)
		if (newer) for (const cut of [...cuttable]) cut()
		rebuilder.request(revision)
	}

	const participant = createHuman({
		name: "bench",
		capabilities: [],
		handlers: [
			{
				specification: when(({ event }) => isEvent(event, "design.settled") || (isEvent(event, "artifact.ready") && event.payload.kind === "firmware")),
				processor: {
					apply: ({ event }) => {
						const firmware = state().artifacts.firmware
						if (isEvent(event, "design.settled")) {
							const first = !settledOnce
							settledOnce = true
							if (first && firmware?.ok) request(firmware.revision)
							return
						}
						if (settledOnce && isEvent(event, "artifact.ready")) request(event.payload.revision)
					},
				},
			},
		],
	})
	self.id = participant.getId()
	state().roles.set(self.id, "bench")
	queueMicrotask(() => send("bench.connected", { source, ports: hello.ports, meter: hello.meter }))
	Object.defineProperty(participant, "idle", { get: () => rebuilder.idle })
	return Object.assign(participant, {
		async whenIdle(timeoutMs: number) {
			const end = Date.now() + timeoutMs
			while (!rebuilder.idle && Date.now() < end) await sleep(100)
		},
		async close() {
			clearInterval(flush)
			await bridge.close()
		},
	}) as Bench
}
