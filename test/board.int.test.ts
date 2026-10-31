import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { boardParts, circuitFromContract } from "../src/codegen/circuit.ts"
import { checkConsistency } from "../src/contract/consistency.ts"
import { netsFromCircuitJson, partsFromCircuitJson } from "../src/tools/board-nets.ts"
import { fixtureContract } from "./fixture.ts"

const KICAD_IMAGE = "kicad/kicad:10.0"
const PATH = [fileURLToPath(new URL("../tools/node/node_modules/.bin", import.meta.url)), process.env.PATH].join(delimiter)
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

	const board = { revision: s.revision, dir, pcbPath, stepPath: null, renderPath: null, widthMm: pcb.width, heightMm: pcb.height, nets: netsFromCircuitJson(elements), parts: partsFromCircuitJson(elements) }
	// The real build carries each part's MPN, so the part check compares MPNs rather than skipping them.
	for (const p of s.values.parts!) assert.equal(board.parts[p.ref]?.mpn, p.mpn, p.ref)
	const kinds = checkConsistency(s, { board }).map((v) => v.kind)
	assert.ok(!kinds.includes("net-missing"), `violations: ${kinds}`)
	assert.ok(!kinds.includes("outline-mismatch"), `violations: ${kinds}`)
	assert.ok(!kinds.includes("part-mismatch"), `violations: ${kinds}`)
})

// The shape of a real mock run: LDO, USB-C on the bottom, a button on top, a status LED and 14 passives.
function busyContract() {
	const s = fixtureContract()
	s.values.parts!.push({ ref: "U3", role: "ldo", mpn: "AP2112K-3.3TRG1", lcsc: "C51118", footprint: "sot23_5", pins: ["VIN", "GND", "EN", "NC", "VOUT"] })
	s.values.connectors = [
		{ ref: "J1", kind: "usb-c", edge: "bottom", offsetMm: 25, widthMm: 9, heightMm: 7 },
		{ ref: "SW1", kind: "button", edge: "top", offsetMm: 25, widthMm: 4, heightMm: 3 },
	]
	s.values.pins!.push({ signal: "STATUS_LED", gpio: 10, partRef: "D1", partPin: "A" })
	for (let i = 1; i <= 7; i++) {
		s.values.parts!.push({ ref: `R${i}`, role: "resistor", mpn: "0402WGF1001TCE", lcsc: "C11702", footprint: "0402", pins: ["pin1", "pin2"] })
		s.values.parts!.push({ ref: `C${i}`, role: "capacitor", mpn: "CL05B104KO5NNNC", lcsc: "C1525", footprint: "0402", pins: ["pin1", "pin2"] })
	}
	return s
}

for (const [name, contract] of [["fixture", fixtureContract], ["busy mock-run contract", busyContract]] as const) {
	test(`${name}: built components don't overlap and stay on the board`, { skip: !hasTsci && "tsci is missing", timeout: 300_000 }, () => {
		const s = contract()
		const dir = mkdtempSync(join(tmpdir(), "bringup-board-"))
		writeFileSync(join(dir, "board.circuit.tsx"), circuitFromContract(s))
		execFileSync("tsci", ["build", "board.circuit.tsx"], { cwd: dir, env: { ...process.env, PATH }, stdio: "pipe" })
		const elements = JSON.parse(readFileSync(join(dir, "dist/board/circuit.json"), "utf8"))
		const names = new Map(elements.filter((e: any) => e.type === "source_component").map((e: any) => [e.source_component_id, e.name]))
		const boxes = elements.filter((e: any) => e.type === "pcb_component").map((c: any) => ({ ref: names.get(c.source_component_id), x: c.center.x, y: c.center.y, w: c.width, h: c.height }))
		const { widthMm: w, heightMm: h } = s.values.outline!
		assert.equal(boxes.length, boardParts(s).length, "component count")
		for (const b of boxes) assert.ok(Math.abs(b.x) + b.w / 2 <= w / 2 && Math.abs(b.y) + b.h / 2 <= h / 2, `${b.ref} is outside the ${w}×${h} board`)
		for (let i = 0; i < boxes.length; i++) {
			for (let j = i + 1; j < boxes.length; j++) {
				const [a, b] = [boxes[i], boxes[j]]
				const gap = Math.max(Math.abs(a.x - b.x) - (a.w + b.w) / 2, Math.abs(a.y - b.y) - (a.h + b.h) / 2)
				assert.ok(gap > 0, `${a.ref} overlaps ${b.ref}`)
			}
		}
		assert.ok(elements.some((e: any) => e.type === "pcb_trace"), "autorouter produced no traces")
	})
}
