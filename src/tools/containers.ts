import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { run, type RunResult } from "./exec.ts"

// The Docker containers a build starts and waits on (Freerouting and its KiCad steps): each one named and labelled with
// this process's pid, removed when it times out and when this process exits, and any left by a process that is gone
// removed before the next one starts. `docker run --rm` alone removes a container only once it stops: when the run
// ended mid-build its client went with it and the container kept routing (lead-3's CNC mock 15: a 4-layer retry's
// Freerouting at ~120 % CPU after the run exited, stopped by hand, 27 Nov 2026).
export const CONTAINER_LABEL = "bringup.pid"
const live = new Set<string>()
let hooked = false

function hook(): void {
	if (hooked) return
	hooked = true
	process.on("exit", () => {
		if (live.size) spawnSync("docker", ["rm", "-f", ...live], { stdio: "ignore" })
	})
}

// The containers of processes that are gone (their pid label names no live process): removed, quietly.
let swept = false
export async function sweepOrphans(): Promise<string[]> {
	const r = await run("docker", ["ps", "-a", "--filter", `label=${CONTAINER_LABEL}`, "--format", `{{.Names}} {{.Label "${CONTAINER_LABEL}"}}`], { timeoutMs: 20_000 })
	if (r.code !== 0) return []
	const alive = (pid: number) => {
		try {
			process.kill(pid, 0)
			return true
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "EPERM"
		}
	}
	const gone = r.stdout.split("\n").map((l) => l.trim().split(" ")).filter(([name, pid]) => name && Number(pid) > 0 && Number(pid) !== process.pid && !alive(Number(pid))).map(([name]) => name)
	if (gone.length) await run("docker", ["rm", "-f", ...gone], { timeoutMs: 30_000 })
	return gone
}

// `docker run --rm` with a name and this process's label; removed if it outlives its timeout or this process.
export async function dockerRun(kind: string, args: string[], timeoutMs: number): Promise<RunResult> {
	hook()
	if (!swept) {
		swept = true
		await sweepOrphans()
	}
	const name = `bringup-${kind}-${process.pid}-${randomBytes(3).toString("hex")}`
	live.add(name)
	try {
		const r = await run("docker", ["run", "--rm", "--name", name, "--label", `${CONTAINER_LABEL}=${process.pid}`, ...args], { timeoutMs })
		// Timed out: the client is killed, the container is not.
		if (r.code === -1) await run("docker", ["rm", "-f", name], { timeoutMs: 30_000 })
		return r
	} finally {
		live.delete(name)
	}
}
