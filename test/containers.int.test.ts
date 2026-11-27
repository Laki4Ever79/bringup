// A build's Docker containers don't outlive it: one whose process exits mid-run is removed (the run's end), and one
// left by a process that is gone is swept before the next starts (lead-3's CNC mock 15: a Freerouting container kept
// running at ~120 % CPU after its run exited, 27 Nov 2026). Needs Docker and the KiCad image.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { CONTAINER_LABEL, sweepOrphans } from "../src/tools/containers.ts"
import { KICAD_IMAGE } from "../src/tools/env.ts"
import { tempDir } from "./helpers.ts"

const image = spawnSync("docker", ["image", "inspect", KICAD_IMAGE], { stdio: "ignore" }).status === 0
const skip = !image && "Docker or the KiCad image missing"
const names = (filter: string) => spawnSync("docker", ["ps", "-a", "--filter", filter, "--format", "{{.Names}}"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean)
const containers = fileURLToPath(new URL("../src/tools/containers.ts", import.meta.url))

test("a container started by a process that exits mid-run is removed with it", { skip, timeout: 120_000 }, async () => {
	const dir = tempDir()
	const script = join(dir, "child.ts")
	// The child starts a long container, then exits while it runs (the run's end under a build).
	writeFileSync(script, `import { dockerRun } from ${JSON.stringify(containers)}\nvoid dockerRun("test", [${JSON.stringify(KICAD_IMAGE)}, "sleep", "300"], 600_000)\nsetTimeout(() => process.exit(0), 4000)\n`)
	const child = spawn(process.execPath, ["--import", "tsx", script], { stdio: "ignore" })
	// Seen running while the child lives.
	let seen: string[] = []
	for (let i = 0; i < 40 && !seen.length; i++) {
		await new Promise((r) => setTimeout(r, 250))
		seen = names(`label=${CONTAINER_LABEL}=${child.pid}`)
	}
	assert.ok(seen.length, "the container was started")
	await new Promise((r) => child.on("exit", r))
	for (let i = 0; i < 40 && names(`label=${CONTAINER_LABEL}=${child.pid}`).length; i++) await new Promise((r) => setTimeout(r, 250))
	assert.deepEqual(names(`label=${CONTAINER_LABEL}=${child.pid}`), [], "removed when its process exited")
})

test("a container left by a process that is gone is swept", { skip, timeout: 120_000 }, async () => {
	// A pid no process has (above the kernel's default pid_max of 4194304).
	const dead = 4194399
	const name = `bringup-orphan-test-${process.pid}`
	spawnSync("docker", ["run", "-d", "--rm", "--name", name, "--label", `${CONTAINER_LABEL}=${dead}`, KICAD_IMAGE, "sleep", "300"], { stdio: "ignore" })
	assert.deepEqual(names(`name=${name}`), [name])
	const gone = await sweepOrphans()
	assert.ok(gone.includes(name), "swept")
	assert.deepEqual(names(`name=${name}`), [])
})
