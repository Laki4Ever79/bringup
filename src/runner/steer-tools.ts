import { mcuProfileOf } from "../mcu/profile.ts"
import { envFor } from "../mcu/firmware.ts"
import { buildBoard } from "../tools/board.ts"
import { buildChassis } from "../tools/chassis.ts"
import { run, tail } from "../tools/exec.ts"
import { buildFirmware } from "../tools/firmware.ts"
import type { Env } from "../tools/env.ts"
import { cp } from "node:fs/promises"
import type { VerifyTools } from "./steer-verify.ts"

const COMPILE_TIMEOUT_MS = 600_000

// The run's own builders' tools, for verifying an edit made while paused (runner/steer-verify.ts): the same firmware,
// board and chassis builds, into a scratch folder, so nothing of the run's revisions is touched.
export function steerTools(env: Env): VerifyTools {
	return {
		copyDir: (from, to) => cp(from, to, { recursive: true }),
		async build(kind, snapshot, dir) {
			const revision = snapshot.revision
			if (kind === "firmware") {
				if (!env.pio) return { ok: true, detail: "not compiled: PlatformIO is not installed" }
				const fw = await buildFirmware(env.pio, env.root, dir, snapshot, revision)
				const tests = fw.driverTests
				if (!fw.ok) return { ok: false, detail: `firmware does not compile:\n${tail(fw.log, 12)}`, artifact: fw }
				if (tests?.ok === false) return { ok: false, detail: `drivers fail their host tests: ${tests.failed.map((f) => `${f.name}: ${f.message}`).join("; ")}`, artifact: fw }
				return { ok: true, detail: `compiles${tests && !tests.skipped ? `; ${tests.passed} driver tests pass` : ""}`, artifact: fw }
			}
			if (kind === "board") {
				const board = await buildBoard(env, dir, snapshot, revision)
				return { ok: true, detail: `routed: ${board.widthMm}×${board.heightMm} mm${board.drc ? `, DRC ${board.drc.errors ?? 0} errors` : ""}`, artifact: board }
			}
			if (!env.python) return { ok: true, detail: "not built: the .venv python with build123d is not installed" }
			const r = await buildChassis(env.python, env.root, dir, snapshot, revision)
			return r.ok ? { ok: true, detail: `built: ${r.files.length} files`, artifact: r } : { ok: false, detail: `chassis build failed: ${r.reason}` }
		},
		async compileFirmware(dir, snapshot) {
			if (!env.pio) return { ok: true, log: "not compiled: PlatformIO is not installed" }
			const r = await run(env.pio, ["run", "-d", dir, "-e", envFor(mcuProfileOf(snapshot.values.parts), "app")], { timeoutMs: COMPILE_TIMEOUT_MS })
			return { ok: r.code === 0, log: `${r.stdout ?? ""}\n${r.stderr ?? ""}` }
		},
	}
}
