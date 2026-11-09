// One-off: build the scripted rover's board with the real tools (tscircuit, KiCad DRC). Plan Task 5, step 5.
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { buildBoard } from "../src/tools/board.ts"
import { detectEnvironment } from "../src/tools/env.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
const root = resolve(import.meta.dirname, "..")
const env = await detectEnvironment(root)
const dir = resolve(root, "out/rover-board/board/rev-1")
mkdirSync(dir, { recursive: true })
const a = await buildBoard(env, dir, { revision: 1, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) }, 1)
console.log(JSON.stringify({ ok: (a as { ok?: boolean }).ok, drc: (a as { drc?: unknown }).drc, keys: Object.keys(a) }, null, 1).slice(0, 1500))
