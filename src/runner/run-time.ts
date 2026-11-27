// How long a run may take, and what extends it (lead-2 and the CNC's full mock, 27 Nov 2026: a fixed 30 or 60 min cap
// ended a run whose design had settled at 8 min while its 26-min board build was still running, so the run reported
// "board not built" with nothing wrong). The base cap is the design's time; a build still running at the cap is waited
// for, up to BUILD_GRACE more minutes, so a run is never cut off just before its board. The plan the person approves
// says both numbers. Pure: run.ts and the plan gate both read it.
import { resolveProvider } from "../inference/providers.ts"

// The design's time: 30 min, 60 on the Claude subscription (its turns take about 20 s each: the first rover run there,
// 15 Nov, hit 30 min with a board build in flight). BRINGUP_TIMEOUT_MIN overrides it.
export function baseRunMs(env: Record<string, string | undefined> = process.env): number {
	return Number(env.BRINGUP_TIMEOUT_MIN) > 0 ? Number(env.BRINGUP_TIMEOUT_MIN) * 60_000 : resolveProvider(env)?.protocol === "claude-code" ? 60 * 60_000 : 30 * 60_000
}

// The longest a build still in flight at the cap is waited for: 45 min, above the largest board build measured (the CNC's
// 4-layer board, 1565 s, 27 Nov 2026). BRINGUP_BUILD_GRACE_MIN changes it; 0 turns it off.
export function buildGraceMs(env: Record<string, string | undefined> = process.env): number {
	const v = env.BRINGUP_BUILD_GRACE_MIN
	return v !== undefined && v !== "" && Number(v) >= 0 ? Number(v) * 60_000 : 45 * 60_000
}

// The plan's line: "stops after about N min, or up to M if a build is still finishing".
export function runTimeText(env: Record<string, string | undefined> = process.env): string {
	const base = Math.round(baseRunMs(env) / 60_000)
	const grace = Math.round(buildGraceMs(env) / 60_000)
	return grace > 0 ? `The run stops after about ${base} min, or up to ${base + grace} min if a build (the board, firmware) is still finishing then.` : `The run stops after about ${base} min.`
}

// The deadline: resolves at the cap, or, while any build is in flight then, when the builds are done or the grace is
// used up. inFlight lists the builds running now (builders.ts buildsInFlight); onExtend says once that it waits.
export function runDeadline(capMs: number, graceMs: number, inFlight: () => string[], onExtend: (kinds: string[]) => void, pollMs = 10_000): Promise<void> {
	const t0 = Date.now()
	return new Promise((resolve) => {
		let told = false
		const check = () => {
			const running = inFlight()
			if (running.length && Date.now() - t0 < capMs + graceMs) {
				if (!told) onExtend(running)
				told = true
				setTimeout(check, pollMs).unref()
			} else resolve()
		}
		setTimeout(check, capMs).unref()
	})
}
