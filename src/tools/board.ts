import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { circuitFromContract } from "../codegen/circuit.ts"
import type { BoardArtifact } from "../contract/consistency.ts"
import type { ContractSnapshot } from "../contract/types.ts"
import { netsFromCircuitJson } from "./board-nets.ts"
import { kicadCli, toolPath, type Env } from "./env.ts"
import { run, tail } from "./exec.ts"

// Contract -> tscircuit source -> placed and autorouted board -> KiCad project, STEP and render.
// tscircuit's own result is the source of truth for nets and size; KiCad exports are best-effort.
export async function buildBoard(env: Env, dir: string, s: ContractSnapshot, revision: number): Promise<BoardArtifact> {
	if (!env.tsci) throw new Error("tscircuit build failed: tsci is not installed (tools/node)")
	// tscircuit treats the nearest package.json as its project: inside this repo it would look for
	// react in our node_modules and write to the repo's dist/. Build outside any project, then copy.
	const work = mkdtempSync(join(tmpdir(), "bringup-board-"))
	try {
		return await buildIn(env, work, s, revision, dir)
	} finally {
		rmSync(work, { recursive: true, force: true })
	}
}

async function buildIn(env: Env, work: string, s: ContractSnapshot, revision: number, dir: string): Promise<BoardArtifact> {
	writeFileSync(join(work, "board.circuit.tsx"), circuitFromContract(s))
	const build = await run(env.tsci!, ["build", "board.circuit.tsx", "--kicad-project"], { cwd: work, timeoutMs: 300_000, env: { PATH: toolPath(env) } })
	const circuitPath = join(work, "dist/board/circuit.json")
	if (build.code !== 0 || !existsSync(circuitPath)) {
		throw new Error(`tscircuit build failed (exit ${build.code}):\n${tail(build.stdout + "\n" + build.stderr, 40)}`)
	}
	const elements = JSON.parse(readFileSync(circuitPath, "utf8")) as { type: string; width?: number; height?: number }[]
	const pcb = elements.find((e) => e.type === "pcb_board")
	const pcbRel = "dist/board/kicad/board.kicad_pcb"

	const step = await kicadCli(env, ["pcb", "export", "step", "-o", "board.step", pcbRel], work, 180_000)
	const render = await kicadCli(env, ["pcb", "render", "-o", "board.png", "--side", "top", pcbRel], work, 180_000)
	cpSync(work, dir, { recursive: true })

	return {
		revision,
		dir,
		pcbPath: join(dir, pcbRel),
		stepPath: step.code === 0 && existsSync(join(dir, "board.step")) ? join(dir, "board.step") : null,
		renderPath: render.code === 0 && existsSync(join(dir, "board.png")) ? join(dir, "board.png") : null,
		widthMm: pcb?.width ?? 0,
		heightMm: pcb?.height ?? 0,
		nets: netsFromCircuitJson(elements),
	}
}
