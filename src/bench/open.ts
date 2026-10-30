import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { Bridge, BridgeHello, BenchSource } from "../tools/bench-bridge.ts"

// Rehearsal recordings of the bench (bench.jsonl from a real session), played back when no board is plugged in.
export const RECORDINGS_DIR = "fixtures/bench"

export function latestRecording(root: string): string | null {
	const dir = join(root, RECORDINGS_DIR)
	if (!existsSync(dir)) return null
	const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()
	return files.length ? join(dir, files.at(-1)!) : null
}

export function benchArgs(root: string, source: BenchSource, outDir: string, replay?: string): string[] {
	return [join(root, "py/bench.py"), "--source", source, "--out", join(outDir, "bench"), ...(replay ? ["--replay", replay] : [])]
}

// Starts the bridge for --bench. A real bench with no board on USB falls back to the newest recording as a replay
// (badged REPLAY, never proposes), and with no recording either to the fake bench, so the stage never goes dark.
export async function openBench(opts: {
	root: string
	source: BenchSource
	outDir: string
	replay?: string
	start: (args: string[]) => Bridge
	log?: (message: string) => void
}): Promise<{ bridge: Bridge; hello: BridgeHello }> {
	const log = opts.log ?? ((m: string) => console.log(`[bench] ${m}`))
	const open = async (source: BenchSource, replay?: string) => {
		const bridge = opts.start(benchArgs(opts.root, source, opts.outDir, replay))
		return { bridge, hello: await bridge.hello }
	}
	if (opts.source === "replay") {
		const file = opts.replay ?? latestRecording(opts.root)
		if (!file) throw new Error(`--bench replay needs a recording: pass --bench-replay FILE or record one into ${RECORDINGS_DIR}/`)
		return open("replay", file)
	}
	const first = await open(opts.source)
	if (opts.source !== "real" || first.hello.ports.dut !== null) return first
	await first.bridge.close()
	const recording = opts.replay ?? latestRecording(opts.root)
	if (recording) {
		log(`no board on USB: falling back to a replay of ${recording}`)
		return open("replay", recording)
	}
	log("no board on USB and no recording: falling back to the fake bench")
	return open("fake")
}
