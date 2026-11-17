// The firmware's motor and sensor drivers, run on the host after the build (templates/drivers/host/drivertest.cpp):
// each driver the design uses, against a simulated chip, with the design's own generated header. Compiling proves the
// code builds; this proves it sends each chip the right bytes, waits as long as the datasheet says, rejects a bad CRC
// and converts the units right. A missing host compiler skips the tests (ok: null); it never fails a design.
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sensorDriver } from "../codegen/firmware.ts"
import { roverHeader } from "../mechanics/firmware.ts"
import type { ContractSnapshot } from "../contract/types.ts"

export type DriverId = "drv8833" | "vl53l0x" | "sht40" | "shtc3" | "lsm6ds3"

export interface DriverTestResult {
	ok: boolean | null // null: not run (skipped says why)
	drivers: DriverId[]
	passed: string[]
	failed: { name: string; message: string }[]
	log: string
	skipped?: string
}

const TIMEOUT_MS = 60_000

// The drivers a design's firmware is built with. A robot (the rover firmware): the DRV8833, the VL53L0X and, when its
// header selects one, the SHT40 payload. Otherwise the product firmware's climate sensor, as pins.h selects it.
export function driverSet(s: ContractSnapshot): DriverId[] {
	const sensorMpn = (s.values.parts ?? []).find((p) => p.role === "sensor")?.mpn ?? ""
	if (s.values.mechanics && s.values.motion) {
		const payload = /#define SENSOR_SHT40 1/.test(safeRoverHeader(s)) ? (["sht40"] as const) : []
		// Every robot's IMU (the user, 17 Nov 2026: "Every robot"): the gyro's heading closes its turns.
		const imu = (s.values.parts ?? []).some((p) => p.role === "imu") ? (["lsm6ds3"] as const) : []
		return ["drv8833", "vl53l0x", ...payload, ...imu]
	}
	const d = sensorDriver(sensorMpn)
	return d === "SHTC3" ? ["shtc3"] : d === "SHT40" ? ["sht40"] : []
}

function safeRoverHeader(s: ContractSnapshot): string {
	try {
		return roverHeader(s)
	} catch {
		return ""
	}
}

function run(cmd: string, args: string[], cwd?: string): Promise<{ code: number | null; output: string; spawnError?: string }> {
	return new Promise((resolve) => {
		let output = ""
		const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: TIMEOUT_MS })
		child.stdout.on("data", (d) => { output += d })
		child.stderr.on("data", (d) => { output += d })
		child.on("error", (e) => resolve({ code: null, output, spawnError: e.message }))
		child.on("close", (code) => resolve({ code, output }))
	})
}

// Compiles and runs the host tests in fwDir (prepareFirmware put include/drivers and test_host there).
export async function runDriverTests(fwDir: string, s: ContractSnapshot, opts: { cxx?: string } = {}): Promise<DriverTestResult> {
	const drivers = driverSet(s)
	const base = { drivers, passed: [] as string[], failed: [] as { name: string; message: string }[] }
	const src = join(fwDir, "test_host/drivertest.cpp")
	if (!existsSync(src)) return { ...base, ok: null, log: "", skipped: "no host driver tests in this firmware folder" }
	const cxx = opts.cxx ?? process.env.CXX ?? "g++"
	const out = await mkdtemp(join(tmpdir(), "bringup-drivertest-"))
	try {
		const exe = join(out, "drivertest")
		const flags = ["-std=c++17", "-O0", "-Wall", `-I${join(fwDir, "test_host")}`, `-I${join(fwDir, "include")}`, ...drivers.map((d) => `-DTEST_${d.toUpperCase()}`)]
		const build = await run(cxx, [...flags, src, "-o", exe])
		if (build.spawnError) return { ...base, ok: null, log: build.spawnError, skipped: `no host C++ compiler (${cxx}): ${build.spawnError}` }
		if (build.code !== 0) return { ...base, ok: false, failed: [{ name: "host build", message: "the drivers don't compile on the host" }], log: build.output.trim().split("\n").slice(-30).join("\n") }
		const r = await run(exe, [])
		const lines = r.output.split("\n")
		const passed = lines.filter((l) => l.startsWith("PASS ")).map((l) => l.slice(5))
		const failed = lines.filter((l) => l.startsWith("FAIL ")).map((l) => {
			const rest = l.slice(5)
			const i = rest.indexOf(": ")
			return i < 0 ? { name: rest, message: "" } : { name: rest.slice(0, i), message: rest.slice(i + 2) }
		})
		// A crash (no exit code, or an exit code with no FAIL line) is a failure too.
		if (r.code !== 0 && failed.length === 0) failed.push({ name: "host run", message: `exited ${r.code ?? "abnormally"}` })
		return { drivers, ok: failed.length === 0, passed, failed, log: r.output.trim() }
	} finally {
		await rm(out, { recursive: true, force: true })
	}
}
