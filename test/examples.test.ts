// Shipped examples for the start screen (src/dashboard/examples.ts): a finished run trimmed to what the viewer needs.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { listExamples, saveExample } from "../src/dashboard/examples.ts"
import { circuitIndex } from "../src/dashboard/pcb-view.js"
import { serveHub } from "../src/dashboard/server.ts"
import { tempDir } from "./helpers.ts"

const CIRCUIT = [
	{ type: "pcb_board", center: { x: 0, y: 0 }, width: 50, height: 30 },
	{ type: "source_component", source_component_id: "sc1", name: "U1" },
	{ type: "pcb_component", pcb_component_id: "pc1", source_component_id: "sc1", center: { x: 1, y: 2 }, width: 4, height: 4 },
	{ type: "schematic_port", schematic_port_id: "x", note: "the schematic is not drawn by the viewer" },
	{ type: "pcb_silkscreen_path", pcb_silkscreen_path_id: "s" },
]

function fakeSystemRun(root: string) {
	const dir = join(root, "system-x")
	writeFileSync(join(mkdirSync(dir, { recursive: true }) ?? dir, "system.json"), JSON.stringify({ name: "two", boards: [{ name: "logger", brief: "b" }, { name: "beacon", brief: "b" }], links: [{ id: "L1", kind: "uart", a: { board: "logger" }, b: { board: "beacon" }, cable: { lengthMm: 300 } }] }))
	for (const b of ["logger", "beacon"]) {
		const bd = join(dir, "boards", b)
		mkdirSync(join(bd, "board"), { recursive: true })
		mkdirSync(join(bd, "enclosure", "rev-4"), { recursive: true })
		mkdirSync(join(bd, "enclosure", "rev-12"), { recursive: true })
		writeFileSync(join(bd, "contract.json"), JSON.stringify({ values: { outline: { widthMm: 50, heightMm: 30 } } }))
		writeFileSync(join(bd, "brief.md"), `# Brief: ${b}\n`)
		writeFileSync(join(bd, "board", "circuit.json"), JSON.stringify(CIRCUIT))
		writeFileSync(join(bd, "board", "board.png"), "png")
		writeFileSync(join(bd, "enclosure", "rev-4", "case.stl"), "old")
		writeFileSync(join(bd, "enclosure", "rev-12", "case.stl"), "new")
		writeFileSync(join(bd, "enclosure", "rev-12", "spec.json"), "{}")
		writeFileSync(join(bd, "enclosure", "rev-12", "case.step"), "not needed")
		writeFileSync(join(bd, "trace.jsonl"), "not needed\n")
	}
	return dir
}

test("an example keeps only what the viewer reads: the last case, the trimmed circuit, the contract and the render", () => {
	const root = tempDir()
	const dest = tempDir()
	saveExample(fakeSystemRun(root), "two-boards", "Two boards over a cable", dest)
	const ex = join(dest, "two-boards")
	const meta = JSON.parse(readFileSync(join(ex, "example.json"), "utf8"))
	assert.equal(meta.sentence, "Two boards over a cable")
	assert.deepEqual(meta.boards.map((b: { name: string }) => b.name), ["logger", "beacon"])
	assert.equal(meta.links.length, 1)
	assert.deepEqual(readdirSync(join(ex, "boards", "logger")).sort(), ["board.png", "case.stl", "circuit.json", "contract.json", "spec.json"])
	assert.equal(readFileSync(join(ex, "boards", "logger", "case.stl"), "utf8"), "new", "the newest enclosure revision")
	const trimmed = JSON.parse(readFileSync(join(ex, "boards", "logger", "circuit.json"), "utf8"))
	assert.deepEqual(circuitIndex(trimmed), circuitIndex(CIRCUIT))
	assert.equal(trimmed.length, 3)
	assert.deepEqual(listExamples(dest).map((e) => e.name), ["two-boards"])
})

test("the hub lists the examples and serves their files, also in the public demo", async () => {
	const dest = tempDir()
	saveExample(fakeSystemRun(tempDir()), "two-boards", "Two boards over a cable", dest)
	const hub = await serveHub({ outRoot: tempDir(), port: 0, examplesRoot: dest })
	try {
		const list = (await (await fetch(`${hub.url}/api/examples`)).json()) as { name: string }[]
		assert.deepEqual(list.map((e) => e.name), ["two-boards"])
		const f = await fetch(`${hub.url}/examples/two-boards/boards/logger/case.stl`)
		assert.equal(f.status, 200)
		assert.match(f.headers.get("cache-control") ?? "", /max-age/)
		assert.equal((await fetch(`${hub.url}/examples/two-boards/../../etc/passwd`)).status, 404)
		assert.equal((await fetch(`${hub.url}/examples/nope/example.json`)).status, 404)
	} finally {
		await hub.close()
	}
	assert.ok(existsSync(dest))
})
