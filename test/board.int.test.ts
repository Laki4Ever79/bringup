import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { test } from "node:test"
import { circuitFromContract } from "../src/codegen/circuit.ts"
import { checkConsistency } from "../src/contract/consistency.ts"
import { netsFromCircuitJson } from "../src/tools/board-nets.ts"
import { fixtureContract } from "./fixture.ts"

const KICAD_IMAGE = "kicad/kicad:10.0"
const PATH = [new URL("../tools/node/node_modules/.bin", import.meta.url).pathname, process.env.PATH].join(delimiter)
const hasTsci = spawnSync("tsci", ["--version"], { env: { ...process.env, PATH } }).status === 0
const hasKicad = spawnSync("docker", ["image", "inspect", KICAD_IMAGE], { stdio: "ignore" }).status === 0

test("board builds and passes consistency", { skip: !(hasTsci && hasKicad) && "tsci or the kicad docker image is missing", timeout: 300_000 }, () => {
	const s = fixtureContract()
	const dir = mkdtempSync(join(tmpdir(), "bringup-board-"))
	writeFileSync(join(dir, "board.circuit.tsx"), circuitFromContract(s))
	execFileSync("tsci", ["build", "board.circuit.tsx", "--kicad-project"], { cwd: dir, env: { ...process.env, PATH }, stdio: "pipe" })

	const elements = JSON.parse(readFileSync(join(dir, "dist/board/circuit.json"), "utf8"))
	const pcb = elements.find((e: any) => e.type === "pcb_board")
	const pcbPath = join(dir, "dist/board/kicad/board.kicad_pcb")
	assert.ok(existsSync(pcbPath))
	assert.ok(elements.some((e: any) => e.type === "pcb_trace"), "autorouter produced no traces")

	// KiCad must load the exported board; its DRC is advisory (tscircuit routes 0.15 mm tracks).
	execFileSync("docker", ["run", "--rm", "-u", `${process.getuid!()}:${process.getgid!()}`, "-e", "HOME=/tmp", "-v", `${dir}:/w`, "-w", "/w",
		KICAD_IMAGE, "kicad-cli", "pcb", "drc", "--format", "json", "-o", "drc.json", "dist/board/kicad/board.kicad_pcb"], { stdio: "pipe" })
	assert.ok(existsSync(join(dir, "drc.json")))

	const board = { revision: s.revision, dir, pcbPath, stepPath: null, renderPath: null, widthMm: pcb.width, heightMm: pcb.height, nets: netsFromCircuitJson(elements) }
	const kinds = checkConsistency(s, { board }).map((v) => v.kind)
	assert.ok(!kinds.includes("net-missing"), `violations: ${kinds}`)
	assert.ok(!kinds.includes("outline-mismatch"), `violations: ${kinds}`)
})
