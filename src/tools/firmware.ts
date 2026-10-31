import { spawn } from "node:child_process"
import { cp, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { behaviorHeader, parsePinsHeader, parseSensorHeader, pinsHeader } from "../codegen/firmware.ts"
import type { FirmwareArtifact } from "../contract/consistency.ts"
import type { ContractSnapshot } from "../contract/types.ts"

const TIMEOUT_MS = 600_000
const LOG_LINES = 60

function run(cmd: string, args: string[]): Promise<{ code: number | null; output: string }> {
	return new Promise((resolve) => {
		let output = ""
		const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], timeout: TIMEOUT_MS })
		child.stdout.on("data", (d) => { output += d })
		child.stderr.on("data", (d) => { output += d })
		child.on("error", (e) => { output += `\n${e.message}`; resolve({ code: null, output }) })
		child.on("close", (code) => resolve({ code, output }))
	})
}

// Copies templates/fw into dir, writes include/pins.h and include/behavior.h and compiles it. A failed build returns ok: false.
export async function buildFirmware(pio: string, root: string, dir: string, s: ContractSnapshot, revision: number): Promise<FirmwareArtifact> {
	const header = pinsHeader(s)
	await cp(join(root, "templates/fw"), dir, { recursive: true })
	await mkdir(join(dir, "include"), { recursive: true })
	await writeFile(join(dir, "include/pins.h"), header)
	await writeFile(join(dir, "include/behavior.h"), behaviorHeader(s))
	const { code, output } = await run(pio, ["run", "-d", dir])
	return {
		revision,
		ok: code === 0,
		pins: parsePinsHeader(header),
		sensor: parseSensorHeader(header),
		log: output.trimEnd().split("\n").slice(-LOG_LINES).join("\n"),
	}
}
