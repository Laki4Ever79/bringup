import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { crc32 } from "node:zlib"
import { boardParts, type BoardPart } from "../codegen/circuit.ts"
import type { BoardArtifact } from "../contract/consistency.ts"
import type { ContractSnapshot } from "../contract/types.ts"
import { kicadCli, toolPath, type Env } from "./env.ts"
import { run, tail } from "./exec.ts"

// A fab package in JLCPCB's assembly format (PCBWay takes the same files): gerbers + drill, BOM and CPL.
export interface FabPackage {
	dir: string
	gerbersZip: string
	bom: string
	cpl: string
	readme: string
}

// The layers JLCPCB needs for a 2-layer board.
const LAYERS = ["F.Cu", "B.Cu", "F.Mask", "B.Mask", "F.Silkscreen", "B.Silkscreen", "F.Paste", "B.Paste", "Edge.Cuts"]
// A 4-layer board's inner copper too (In1 ground, In2 the power planes; circuit.ts boardLayers).
const layersOf = (pcb: string) => (existsSync(pcb) && /\(\d+ "In1\.Cu"/.test(readFileSync(pcb, "utf8")) ? ["F.Cu", "In1.Cu", "In2.Cu", ...LAYERS.slice(1)] : LAYERS)
const TIMEOUT_MS = 120_000

const quote = (s: string) => `"${s.replace(/"/g, '""')}"`
const naturalRef = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true })

// JLC BOM: one row per distinct part, its designators comma-joined.
export function bomCsv(parts: BoardPart[]): string {
	const groups = new Map<string, BoardPart[]>()
	for (const p of parts) {
		const key = p.lcsc ?? `mpn:${p.mpn}:${p.footprint}`
		groups.set(key, [...(groups.get(key) ?? []), p])
	}
	const rows = [...groups.values()].map((g) => {
		const first = g[0]
		const refs = g.map((p) => p.ref).sort(naturalRef).join(",")
		return [first.value ?? first.mpn, refs, first.footprint, first.lcsc ?? ""].map(quote).join(",")
	})
	return ["Comment,Designator,Footprint,LCSC Part #", ...rows.sort((a, b) => naturalRef(a.split(",")[1], b.split(",")[1]))].join("\n") + "\n"
}

function csvRow(line: string): string[] {
	const out: string[] = []
	let field = ""
	let quoted = false
	for (let i = 0; i < line.length; i++) {
		const ch = line[i]
		if (quoted) {
			if (ch === '"' && line[i + 1] === '"') (field += '"'), i++
			else if (ch === '"') quoted = false
			else field += ch
		} else if (ch === '"') quoted = true
		else if (ch === ",") out.push(field), (field = "")
		else field += ch
	}
	out.push(field)
	return out
}

// JLC CPL from `kicad-cli pcb export pos --format csv --units mm` (Ref,Val,Package,PosX,PosY,Rot,Side).
export function cplCsv(posCsv: string): string {
	const [header, ...lines] = posCsv.trim().split("\n")
	const col = Object.fromEntries(csvRow(header).map((h, i) => [h, i]))
	// kicad-cli's position file can list footprints with no reference (mounting holes, fiducials: `,122mm,-88mm,Top,0`);
	// they aren't placed parts, and an empty designator row can make JLC's assembly reject or misplace the file.
	const rows = lines.filter(Boolean).map(csvRow).filter((f) => (f[col.Ref] ?? "").trim() !== "").map((f) => {
		const rot = ((Number(f[col.Rot]) % 360) + 360) % 360
		const side = f[col.Side] === "bottom" ? "Bottom" : "Top"
		return `${f[col.Ref]},${+Number(f[col.PosX]).toFixed(4)}mm,${+Number(f[col.PosY]).toFixed(4)}mm,${side},${+rot.toFixed(2)}`
	})
	return ["Designator,Mid X,Mid Y,Layer,Rotation", ...rows].join("\n") + "\n"
}

// A store-only (uncompressed) zip, so the package needs no zip binary and no dependency. Timestamps are fixed at
// 1980-01-01 so the same files always give the same bytes.
export function zipStore(files: { name: string; data: Buffer }[]): Buffer {
	const locals: Buffer[] = []
	const centrals: Buffer[] = []
	let offset = 0
	for (const f of files) {
		const name = Buffer.from(f.name, "utf8")
		const crc = crc32(f.data)
		const local = Buffer.alloc(30)
		local.writeUInt32LE(0x04034b50, 0)
		local.writeUInt16LE(20, 4) // version needed
		local.writeUInt16LE(0x0800, 6) // UTF-8 names
		local.writeUInt16LE(0, 8) // stored
		local.writeUInt16LE(0, 10) // time
		local.writeUInt16LE(0x21, 12) // date: 1980-01-01
		local.writeUInt32LE(crc, 14)
		local.writeUInt32LE(f.data.length, 18)
		local.writeUInt32LE(f.data.length, 22)
		local.writeUInt16LE(name.length, 26)
		local.writeUInt16LE(0, 28)
		const central = Buffer.alloc(46)
		central.writeUInt32LE(0x02014b50, 0)
		central.writeUInt16LE(20, 4) // version made by
		central.writeUInt16LE(20, 6)
		central.writeUInt16LE(0x0800, 8)
		central.writeUInt16LE(0, 10)
		central.writeUInt16LE(0, 12)
		central.writeUInt16LE(0x21, 14)
		central.writeUInt32LE(crc, 16)
		central.writeUInt32LE(f.data.length, 20)
		central.writeUInt32LE(f.data.length, 24)
		central.writeUInt16LE(name.length, 28)
		central.writeUInt32LE(offset, 42)
		locals.push(local, name, f.data)
		centrals.push(central, name)
		offset += local.length + name.length + f.data.length
	}
	const centralDir = Buffer.concat(centrals)
	const end = Buffer.alloc(22)
	end.writeUInt32LE(0x06054b50, 0)
	end.writeUInt16LE(files.length, 8)
	end.writeUInt16LE(files.length, 10)
	end.writeUInt32LE(centralDir.length, 12)
	end.writeUInt32LE(offset, 16)
	return Buffer.concat([...locals, centralDir, end])
}

// Reads back a zip written by zipStore (stored entries only).
export function zipEntries(zip: Buffer): { name: string; data: Buffer }[] {
	const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
	if (end < 0) throw new Error("not a zip file")
	const count = zip.readUInt16LE(end + 10)
	let p = zip.readUInt32LE(end + 16)
	const out = []
	for (let i = 0; i < count; i++) {
		const size = zip.readUInt32LE(p + 20)
		const nameLen = zip.readUInt16LE(p + 28)
		const extraLen = zip.readUInt16LE(p + 30)
		const commentLen = zip.readUInt16LE(p + 32)
		const local = zip.readUInt32LE(p + 42)
		const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8")
		const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
		out.push({ name, data: zip.subarray(dataStart, dataStart + size) })
		p += 46 + nameLen + extraLen + commentLen
	}
	return out
}

function readme(board: BoardArtifact, s: ContractSnapshot, parts: BoardPart[]): string {
	const added = parts.filter((p) => p.added).map((p) => p.ref)
	return `Bringup fab package: board revision ${board.revision}, JLCPCB assembly format (PCBWay accepts the same files)

FILES
  gerbers.zip  Gerber X2 for ${layersOf(board.pcbPath).join(", ")}, plus an Excellon drill file (board.drl)
  bom.csv      Comment, Designator, Footprint, LCSC Part # (one row per distinct part)
  cpl.csv      Designator, Mid X, Mid Y, Layer, Rotation (from KiCad's position export, mm)

BOARD
  ${board.widthMm} x ${board.heightMm} mm, 2 layers, ${parts.length} parts${added.length ? ` (added by codegen, not in the contract: ${added.join(", ")})` : ""}
  KiCad project: ${board.pcbPath}

CHECKLIST: known unverified items. Review the board in KiCad before ordering.
  [ ] ESP32-C3-MINI-1 land pattern is reconstructed from datasheet v2.2: pad numbering and sides are right, pad
      offsets are approximate (about 0.5 mm). Compare with Espressif's land-pattern files.
  [ ] Only module pad 1 is wired to GND; pads 2, 11, 14 and 36-53 (including the thermal pad) are not connected.
      Add them to GND, or pour a ground plane.
  [ ] USB-C D+/D- pads are mapped by position to KiCad's HRO TYPE-C-31-M-12 footprint. A mirrored footprint would
      swap D+ and D-. CC1/CC2 5.1k pull-downs and VBUS/GND are fitted.
  [ ] TP4054 charger pin order (CHRG, GND, BAT, VCC, PROG) is from the pin-compatible LTC4054 symbol, not checked
      against the TP4054 datasheet. PROG 4.7k sets about 210 mA.
  [ ] JST-PH battery polarity: pad 1 is VBAT (+). Battery packs disagree; check the pack before plugging in.
  [ ] The humidity sensor (SHT40 or SHTC3) uses a generic dfn4 footprint and the button a THT stand-in footprint; replace them with the real land patterns.
  [ ] ESP32-C3 EN is tied straight to 3V3; Espressif recommends a 10k / 1uF RC delay.
  [ ] tscircuit routes 0.15 mm tracks. Run DRC with the fab's rules (JLC's minimum is 0.127 mm on 2 layers).
  [ ] CPL rotations are KiCad's. JLC's zero orientation differs per footprint, so check every part in JLC's placement
      preview and correct rotations there.
  [ ] No ground pour, no test points, no mounting holes.

Contract revision ${s.revision}. Generated by Bringup.
`
}

// The board's solder paste as KiCad's export has it, on tscircuit's circuit: each SMD pad's opening the full pad
// (tscircuit makes it 70 % of the pad) and none over plated through-hole pads and slots (tscircuit puts paste on them,
// both sides). A board's stencil doesn't change with whichever tool is installed (fab without KiCad, 26 Nov 2026:
// copper, mask, drills and outline already match KiCad's export exactly; scripts/fab_compare.py).
type CircuitEl = Record<string, unknown> & { type: string }
export function fullPadPaste(circuit: CircuitEl[]): CircuitEl[] {
	const pads = new Map(circuit.filter((e) => e.type === "pcb_smtpad").map((e) => [e.pcb_smtpad_id as string, e]))
	return circuit.flatMap((e) => {
		if (e.type !== "pcb_solder_paste") return [e]
		const pad = pads.get(e.pcb_smtpad_id as string)
		if (!pad) return [] // a through-hole pad's or slot's paste
		const { type: _t, pcb_smtpad_id: _i, port_hints: _h, pcb_port_id: _p, is_covered_with_solder_mask: _m, ...shape } = pad
		return [{ ...e, ...shape, type: "pcb_solder_paste", pcb_smtpad_id: pad.pcb_smtpad_id }]
	})
}

// JLC CPL from tscircuit's pick_and_place.csv (Designator, Mid X, Mid Y, Layer, Rotation; mm, top/bottom).
export function cplFromTscircuit(pnp: string): string {
	const [header, ...lines] = pnp.trim().split("\n")
	const col = Object.fromEntries(csvRow(header).map((h, i) => [h.trim(), i]))
	const rows = lines.filter(Boolean).map((line) => {
		const f = csvRow(line)
		const rot = ((Number(f[col.Rotation]) % 360) + 360) % 360
		return `${f[col.Designator]},${+Number(f[col["Mid X"]]).toFixed(4)}mm,${+Number(f[col["Mid Y"]]).toFixed(4)}mm,${/^bottom$/i.test(f[col.Layer]) ? "Bottom" : "Top"},${+rot.toFixed(2)}`
	})
	return ["Designator,Mid X,Mid Y,Layer,Rotation", ...rows].join("\n") + "\n"
}

// Without KiCad: the fab files from tscircuit's own export of the built board (its circuit.json), the paste made
// KiCad's (fullPadPaste). The BOM is ours, from the contract, as with KiCad.
export async function exportFabWithTscircuit(env: Env, board: BoardArtifact, s: ContractSnapshot, outDir: string): Promise<FabPackage> {
	const circuitPath = join(board.dir, "dist", "board", "circuit.json")
	if (!env.tsci || !existsSync(circuitPath)) throw new Error("no KiCad, and no tscircuit export to fall back on (tsci or the board's circuit.json missing)")
	const work = mkdtempSync(join(tmpdir(), "bringup-fab-"))
	try {
		writeFileSync(join(work, "board.circuit.json"), JSON.stringify(fullPadPaste(JSON.parse(readFileSync(circuitPath, "utf8")))))
		const r = await run(env.tsci, ["export", "board.circuit.json", "-f", "gerbers", "-o", "fab.zip"], { cwd: work, timeoutMs: TIMEOUT_MS, env: { PATH: toolPath(env) } })
		if (r.code !== 0 || !existsSync(join(work, "fab.zip"))) throw new Error(`tsci export gerbers failed (exit ${r.code}): ${tail(r.stderr || r.stdout, 10)}`)
		const entries = zipEntries(readFileSync(join(work, "fab.zip")))
		const pnp = entries.find((e) => e.name.endsWith("pick_and_place.csv"))
		const gerberFiles = entries.filter((e) => !e.name.endsWith(".csv")).sort((x, y) => x.name.localeCompare(y.name))
		const dir = join(outDir, "fab")
		rmSync(dir, { recursive: true, force: true })
		mkdirSync(dir, { recursive: true })
		const parts = boardParts(s)
		const pkg: FabPackage = { dir, gerbersZip: join(dir, "gerbers.zip"), bom: join(dir, "bom.csv"), cpl: join(dir, "cpl.csv"), readme: join(dir, "README.txt") }
		writeFileSync(pkg.gerbersZip, zipStore(gerberFiles))
		writeFileSync(pkg.bom, bomCsv(parts))
		writeFileSync(pkg.cpl, pnp ? cplFromTscircuit(pnp.data.toString("utf8")) : "Designator,Mid X,Mid Y,Layer,Rotation\n")
		writeFileSync(pkg.readme, readme(board, s, parts).replace("(from KiCad's position export, mm)", "(from tscircuit's pick-and-place export, mm; KiCad wasn't installed)"))
		return pkg
	} finally {
		rmSync(work, { recursive: true, force: true })
	}
}

// Writes <outDir>/fab/ with gerbers.zip, bom.csv, cpl.csv and README.txt: from KiCad's export, or without KiCad from
// tscircuit's (exportFabWithTscircuit). Throws when neither can export.
export async function exportFab(env: Env, board: BoardArtifact, s: ContractSnapshot, outDir: string): Promise<FabPackage> {
	if (!env.kicad) return exportFabWithTscircuit(env, board, s, outDir)
	const work = mkdtempSync(join(tmpdir(), "bringup-fab-"))
	try {
		copyFileSync(board.pcbPath, join(work, "board.kicad_pcb"))
		mkdirSync(join(work, "gerbers"))
		const steps = [
			["pcb", "export", "gerbers", "-o", "gerbers/", "--layers", layersOf(join(work, "board.kicad_pcb")).join(","), "board.kicad_pcb"],
			["pcb", "export", "drill", "-o", "gerbers/", "--format", "excellon", "board.kicad_pcb"],
			["pcb", "export", "pos", "-o", "pos.csv", "--format", "csv", "--units", "mm", "board.kicad_pcb"],
		]
		for (const args of steps) {
			const r = await kicadCli(env, args, work, TIMEOUT_MS)
			if (r.code !== 0) throw new Error(`kicad-cli ${args.slice(0, 3).join(" ")} failed (exit ${r.code}): ${tail(r.stderr || r.stdout, 10)}`)
		}

		const dir = join(outDir, "fab")
		rmSync(dir, { recursive: true, force: true })
		mkdirSync(dir, { recursive: true })
		const gerberFiles = readdirSync(join(work, "gerbers")).sort().map((name) => ({ name, data: readFileSync(join(work, "gerbers", name)) }))
		const parts = boardParts(s)
		const pkg: FabPackage = { dir, gerbersZip: join(dir, "gerbers.zip"), bom: join(dir, "bom.csv"), cpl: join(dir, "cpl.csv"), readme: join(dir, "README.txt") }
		writeFileSync(pkg.gerbersZip, zipStore(gerberFiles))
		writeFileSync(pkg.bom, bomCsv(parts))
		writeFileSync(pkg.cpl, cplCsv(readFileSync(join(work, "pos.csv"), "utf8")))
		writeFileSync(pkg.readme, readme(board, s, parts))
		return pkg
	} finally {
		rmSync(work, { recursive: true, force: true })
	}
}
