import type { AgentRole, Connector, ContractSnapshot, FieldName } from "./types.ts"

export interface BoardArtifact {
	revision: number
	dir: string
	pcbPath: string
	stepPath: string | null
	renderPath: string | null
	widthMm: number
	heightMm: number
	// net name -> "REF.pinName" entries
	nets: Record<string, string[]>
	// KiCad design-rule check against the fab's rules (null when KiCad could not run).
	drc?: import("../tools/drc.ts").DrcSummary | null
	// The JLC/PCBWay fab package (gerbers.zip, bom.csv, cpl.csv, README.txt), or why it could not be exported.
	// Best-effort: a failed export never fails the board build.
	fabDir?: string
	fabError?: string
	// Drilled mounting holes, from the board's bottom-left corner (read from tscircuit's circuit.json).
	holes?: { xMm: number; yMm: number; diameterMm: number }[]
}

export interface PrintCheck {
	ok: boolean
	issues: string[]
}

export interface EnclosureArtifact {
	revision: number
	stlPath: string
	stepPath: string
	cutouts: { ref: string; edge: Connector["edge"]; offsetMm: number; widthMm: number; heightMm: number; zMm?: number }[]
	// Measured from the built case, from the board's bottom-left corner; holeMm is the screw pilot hole.
	standoffs?: { xMm: number; yMm: number; holeMm: number }[]
	lidStlPath?: string
	lidStepPath?: string
	printCheck?: PrintCheck
}

export interface FirmwareArtifact {
	revision: number
	ok: boolean
	pins: Record<string, number>
	log: string
}

export interface Artifacts {
	board?: BoardArtifact
	enclosure?: EnclosureArtifact
	firmware?: FirmwareArtifact
}

export type ViolationKind =
	| "outline-mismatch"
	| "net-missing"
	| "pin-mismatch"
	| "cutout-missing"
	| "cutout-misaligned"
	| "standoff-mismatch"
	| "rail-overload"
	| "firmware-build-failed"

export interface Violation {
	kind: ViolationKind
	message: string
	fields: FieldName[]
	affects: AgentRole[]
}

const OUTLINE_TOLERANCE_MM = 0.1
const CUTOUT_TOLERANCE_MM = 0.5
// An M2 screw through a 2.2 mm hole forgives about 0.3 mm of misplacement.
const STANDOFF_TOLERANCE_MM = 0.3
// A post within this distance of an unmatched hole is reported as that hole's post, moved.
const MOUNTING_PAIR_MM = 5

// Plain-code check of every artifact against the contract. Each rule runs only when its inputs exist,
// so a half-built design reports what is wrong so far rather than what is missing.
export function checkConsistency(c: ContractSnapshot, a: Artifacts): Violation[] {
	const v: Violation[] = []
	const { outline, pins, parts, connectors, rails } = c.values

	if (a.board && outline) {
		if (Math.abs(a.board.widthMm - outline.widthMm) > OUTLINE_TOLERANCE_MM || Math.abs(a.board.heightMm - outline.heightMm) > OUTLINE_TOLERANCE_MM) {
			v.push({
				kind: "outline-mismatch",
				message: `board is ${a.board.widthMm}×${a.board.heightMm} mm, contract says ${outline.widthMm}×${outline.heightMm} mm`,
				fields: ["outline"],
				affects: ["board"],
			})
		}
	}

	const mcuRef = parts?.find((p) => p.role === "mcu")?.ref
	if (a.board && pins && mcuRef) {
		for (const pin of pins) {
			const net = a.board.nets[pin.signal] ?? []
			const missing = [`${mcuRef}.GPIO${pin.gpio}`, `${pin.partRef}.${pin.partPin}`].filter((end) => !net.includes(end))
			if (missing.length > 0) {
				v.push({
					kind: "net-missing",
					message: `net ${pin.signal} does not connect ${missing.join(", ")}`,
					fields: ["pins"],
					affects: ["board"],
				})
			}
		}
	}

	if (a.firmware && pins) {
		for (const pin of pins) {
			const built = a.firmware.pins[pin.signal]
			if (built !== pin.gpio) {
				v.push({
					kind: "pin-mismatch",
					message: `firmware drives ${pin.signal} on GPIO${built ?? "?"}, contract says GPIO${pin.gpio}`,
					fields: ["pins"],
					affects: ["firmware"],
				})
			}
		}
	}

	if (a.firmware && !a.firmware.ok) {
		v.push({ kind: "firmware-build-failed", message: "firmware does not compile", fields: ["pins", "parts"], affects: ["firmware"] })
	}

	if (a.enclosure && connectors) {
		for (const conn of connectors) {
			const cut = a.enclosure.cutouts.find((x) => x.ref === conn.ref)
			if (!cut) {
				v.push({ kind: "cutout-missing", message: `enclosure has no cutout for ${conn.ref}`, fields: ["connectors"], affects: ["enclosure"] })
			} else if (
				cut.edge !== conn.edge ||
				Math.abs(cut.offsetMm - conn.offsetMm) > CUTOUT_TOLERANCE_MM ||
				cut.widthMm < conn.widthMm ||
				cut.heightMm < conn.heightMm
			) {
				v.push({
					kind: "cutout-misaligned",
					message: `cutout for ${conn.ref} is ${cut.edge}@${cut.offsetMm} mm ${cut.widthMm}×${cut.heightMm}, connector is ${conn.edge}@${conn.offsetMm} mm ${conn.widthMm}×${conn.heightMm}`,
					fields: ["connectors"],
					affects: ["enclosure"],
				})
			}
		}
	}

	// The board sits on the case's standoffs: every hole needs a post under it, and every post a hole over it.
	const holes = a.board?.holes
	const posts = a.enclosure?.standoffs
	if (holes && posts && posts.length + holes.length > 0) {
		const near = (p: { xMm: number; yMm: number }, q: { xMm: number; yMm: number }) => Math.hypot(p.xMm - q.xMm, p.yMm - q.yMm) <= STANDOFF_TOLERANCE_MM
		const at = (p: { xMm: number; yMm: number }) => `(${+p.xMm.toFixed(2)}, ${+p.yMm.toFixed(2)}) mm`
		const lonePosts = posts.filter((p) => !holes.some((h) => near(p, h)))
		const mismatch = (message: string) => v.push({ kind: "standoff-mismatch", message, fields: ["outline", "connectors"], affects: ["enclosure"] })
		for (const h of holes.filter((h) => !posts.some((p) => near(p, h)))) {
			// A post that moved is one finding, not a lone hole plus a lone post.
			const dist = (p: { xMm: number; yMm: number }) => Math.hypot(p.xMm - h.xMm, p.yMm - h.yMm)
			const nearest = lonePosts.filter((p) => dist(p) <= MOUNTING_PAIR_MM).sort((p, q) => dist(p) - dist(q))[0]
			if (nearest) {
				lonePosts.splice(lonePosts.indexOf(nearest), 1)
				mismatch(`standoff at ${at(nearest)} is ${dist(nearest).toFixed(2)} mm off the board hole at ${at(h)}`)
			} else mismatch(`board hole at ${at(h)} has no standoff under it`)
		}
		for (const p of lonePosts) mismatch(`standoff at ${at(p)} has no board hole over it`)
	}

	for (const rail of rails ?? []) {
		if (rail.loadMa > rail.regulatorMaxMa) {
			v.push({
				kind: "rail-overload",
				message: `${rail.name} draws ${rail.loadMa} mA, regulator is rated ${rail.regulatorMaxMa} mA`,
				fields: ["rails", "parts"],
				affects: ["architect", "parts"],
			})
		}
	}

	return v
}
