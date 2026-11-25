import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { IN_IMAGE, mountDirs, shimScript, toolchainImage } from "../src/tools/toolchain.ts"

const root = new URL("..", import.meta.url).pathname

test("the image tag follows the Dockerfile and its inputs, and is missing without them", () => {
	const copy = mkdtempSync(join(tmpdir(), "tc-"))
	for (const f of ["docker/toolchain", "src/setup/tools-node", "templates/fw/platformio.ini", "templates/fw-rover/platformio.ini"]) cpSync(join(root, f), join(copy, f), { recursive: true })
	const tag = toolchainImage(copy)
	assert.match(tag ?? "", /^bringup-toolchain:[0-9a-f]{12}$/)
	assert.equal(toolchainImage(root), tag)
	writeFileSync(join(copy, "templates/fw/platformio.ini"), "[env:esp32c3]\nplatform = espressif32@9.0.0\n")
	assert.notEqual(toolchainImage(copy), tag)
	assert.equal(toolchainImage(mkdtempSync(join(tmpdir(), "tc-"))), null)
})

test("mount dirs: real paths, nested ones dropped under their parent", () => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "tc-")))
	mkdirSync(join(base, "a/b"), { recursive: true })
	const dirs = mountDirs(join(base, "a/b"), [join(base, "a"), "/nonexistent-dir"])
	assert.ok(dirs.includes(realpathSync(tmpdir())))
	assert.ok(!dirs.some((d) => d.startsWith(join(base, "a"))), "under the temporary folder, so covered by it")
	assert.ok(!dirs.includes("/nonexistent-dir"))
})

// The shim with a fake `docker` first on PATH that prints its arguments: what the real one would run.
test("the shim runs the tool in the image as the caller, with the folders, the current folder and the settings", () => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "tc-")))
	const bin = join(base, "bin"), outside = join(base, "outside dir"), fixed = join(base, "fixed")
	for (const d of [bin, outside, fixed]) mkdirSync(d)
	writeFileSync(join(bin, "docker"), '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n')
	chmodSync(join(bin, "docker"), 0o755)
	const shim = join(base, "pio")
	writeFileSync(shim, shimScript("pio", "bringup-toolchain:abc", [fixed]))
	chmodSync(shim, 0o755)
	const r = spawnSync(shim, ["run", "-d", join(fixed, "fw")], { cwd: outside, encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: "/home/x", PLATFORMIO_BUILD_FLAGS: "-DX", SECRET_TOKEN: "no" } })
	assert.equal(r.status, 0, r.stderr)
	const a = r.stdout.trimEnd().split("\n")
	const at = (flag: string, value: string) => a.some((x, i) => x === flag && a[i + 1] === value)
	assert.deepEqual(a.slice(0, 5), ["run", "--rm", "-i", "--init", "--network"])
	assert.ok(at("-u", `${process.getuid!()}:${process.getgid!()}`))
	assert.ok(at("-w", outside) && at("-e", "HOME=/home/x"))
	assert.ok(at("-v", `${fixed}:${fixed}`) && at("-v", `${outside}:${outside}`), "the fixed folder and the current one, spaces kept")
	assert.ok(at("-e", "PLATFORMIO_BUILD_FLAGS") && !a.includes("SECRET_TOKEN"), "forwarded by name, others not")
	assert.deepEqual(a.slice(-5), ["bringup-toolchain:abc", IN_IMAGE.pio, "run", "-d", join(fixed, "fw")])
	// Inside a fixed folder: no second mount of it.
	const inner = spawnSync(shim, [], { cwd: fixed, encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: "/home/x" } })
	assert.equal(inner.stdout.split("\n").filter((x) => x === `${fixed}:${fixed}`).length, 1)
})
