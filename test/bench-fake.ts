import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Bridge, BridgeAck, BridgeHello, BridgeLine } from "../src/tools/bench-bridge.ts"

// An in-process bridge for bench tests, speaking the same protocol as py/bench.py (bench.md §3b) without timers:
// a flash boots with BRINGUP_REVISION from <dir>/include/pins.h, live mode streams IMU lines with the LED
// toggling, and duty mode streams a whole measurement window of meter samples at once (synthetic `at`).
export class FakeBridge implements Bridge {
	readonly hello: Promise<BridgeHello>
	readonly commands: { cmd: string; [k: string]: unknown }[] = []
	private listeners: ((l: BridgeLine) => void)[] = []
	closed = false

	constructor(
		readonly opts: {
			source?: BridgeHello["source"]
			meter?: boolean
			// Overrides the rev the board boots with after a flash (a board running something else).
			bootRev?: number
			flash?: (cmd: { dir: string }) => BridgeAck
			duty?: { floorMa: number; awakeMa: number; awakeMs: number; periodMs: number; cycles: number }
			// false: a bare S3 (firmware 4bee4a8), "s" lines with zero accel plus an imu err line. "stops": answers, then not.
			imu?: boolean | "stops"
			// Replay: the recorded rev, kept whatever was flashed.
			recordedRev?: number
			// The flash needs the person (factory firmware): an instruct line, then its outcome, before the ack.
			instruct?: { action: string; text: string; done: boolean }
		} = {},
	) {
		this.hello = Promise.resolve({ source: opts.source ?? "real", ports: { dut: "/dev/fake-dut", fixture: "/dev/fake-fixture", telemetry: "/dev/fake-uart" }, meter: opts.meter ?? true })
	}

	onLine(listener: (l: BridgeLine) => void): void {
		this.listeners.push(listener)
	}

	emit(line: Omit<BridgeLine, "at"> & { at?: number }): void {
		for (const l of this.listeners) l({ at: Date.now(), ...line } as BridgeLine)
	}

	private rev = 0

	async command(cmd: { cmd: string; [k: string]: unknown }): Promise<BridgeAck> {
		this.commands.push(cmd)
		await Promise.resolve()
		if (cmd.cmd === "flash") {
			const dir = cmd.dir as string
			const ack = this.opts.flash?.({ dir }) ?? { ok: true, ms: 40, ...(this.opts.source === "replay" ? { simulated: true } : {}) }
			if (!ack.ok) return ack
			const ask = this.opts.instruct
			if (ask) {
				this.emit({ k: "instruct", id: cmd.id ?? 1, action: ask.action, text: ask.text })
				await new Promise((r) => setTimeout(r, 30))
				this.emit({ k: "instruct", id: cmd.id ?? 1, action: ask.action, done: ask.done })
			}
			this.emit({ k: "flashing", stage: "build", pct: 0 })
			this.emit({ k: "flashing", stage: "connect", pct: 0 })
			for (const pct of [0, 50, 100]) this.emit({ k: "flashing", stage: "write", pct })
			const pins = join(dir, "include/pins.h")
			const fromPins = existsSync(pins) ? Number(/BRINGUP_REVISION (\d+)/.exec(readFileSync(pins, "utf8"))?.[1]) : 0
			this.rev = this.opts.recordedRev ?? this.opts.bootRev ?? fromPins
			setTimeout(() => this.boot("live"), 5)
			return ack
		}
		if (cmd.cmd === "mode") {
			setTimeout(() => (cmd.mode === "duty" ? this.dutyWindow() : this.boot("live")), 5)
		}
		return { ok: true }
	}

	private boot(mode: string): void {
		this.emit({ k: "boot", rev: this.rev, reset: "poweron", mode })
		for (let n = 0; n < 6; n++) {
			const answers = this.opts.imu === undefined || this.opts.imu === true || (this.opts.imu === "stops" && n < 3)
			if (answers) this.emit({ k: "s", rev: this.rev, ms: n * 50, ax: 0.2, ay: 0, az: 0.98, tilt: 12, tC: 24.6, led: n % 2 })
			else {
				this.emit({ k: "err", rev: this.rev, what: "imu", detail: "no ACK at 0x68" })
				this.emit({ k: "s", rev: this.rev, ms: n * 50, ax: 0, ay: 0, az: 0, tilt: 0, tC: 0, led: n % 2 })
			}
		}
	}

	private dutyWindow(): void {
		const d = this.opts.duty ?? { floorMa: 6, awakeMa: 66, awakeMs: 180, periodMs: 3000, cycles: 8 }
		this.emit({ k: "boot", rev: this.rev, reset: "deepsleep", mode: "duty" })
		const t0 = Date.now()
		const end = 1000 + d.cycles * d.periodMs + 1000
		for (let t = 0; t < end; t += 17.6) {
			const p = t - 1000
			const on = p >= 0 && p < d.cycles * d.periodMs && p % d.periodMs < d.awakeMs
			this.emit({ k: "i", at: t0 + t, mA: on ? d.awakeMa : d.floorMa })
		}
	}

	async close(): Promise<void> {
		this.closed = true
	}
}
