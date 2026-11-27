import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { recordRoutingFailure, ROUTING_FAILURE } from "../contract/space.ts"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { boardParts, capPaths, circuitFromContract, debugPort, layoutBoard, testPoints, LDO_FROM_USB_MM, moduleBlocked, moduleFreedAlongEdges, placeParts, planeRails, boardLayers, forgetLayerShortfall, recordLayerShortfall, routedWidths, DEFAULT_TRACE_MM, unreachableCaps, wideTracks, type PlacementOptions } from "../codegen/circuit.ts"
import { connectorClashes, pinPartsMissing, pinsWithoutMcu, WAITING_ON_CONTRACT, type BoardArtifact } from "../contract/consistency.ts"
import type { ContractSnapshot } from "../contract/types.ts"
import { holesFromCircuitJson, netsFromCircuitJson, partsFromCircuitJson, placementsFromCircuitJson } from "./board-nets.ts"
import { kicadCli, toolPath, type Env } from "./env.ts"
import { FAB_RULES, runDrc } from "./drc.ts"
import { freeroute, freeroutingAvailable, FREEROUTING_MISSING } from "./freerouting.ts"
import { narrowNets, netCopper } from "./track-widths.ts"
import { nudgeVias } from "./via-edge.ts"
import { alternatePinLabels, hideReferences, pinLabelsToFab, raiseSilkText } from "./silk.ts"
import { run, tail } from "./exec.ts"

// Contract -> tscircuit source -> placed and autorouted board -> KiCad project, STEP and render.
// tscircuit's own result is the source of truth for nets and size; KiCad exports are best-effort.
const FAILED_PER_STAGE = 2
// tscircuit layouts that weren't clean (built with DRC errors, or failed) before Freerouting routes the best of them: more
// layouts rarely clear a crowded board (run 14 rev 36: 20 layouts, 640 s, still 1 clearance error), and on 12 measured
// boards every one tscircuit routes clean, it routes within 2 layouts (17 Nov 2026).
export const LAYOUTS_BEFORE_FREEROUTING = 2
// tscircuit builds per board build, whatever their outcome, before Freerouting takes the best placement (or the first)
// and the search ends: a live run can't wait 20 layouts (run cc-eurobot-17, 16 Nov 2026: no board build finished in 21
// minutes under load, and the run ended judging a board 30 revisions old).
export const MAX_TSCIRCUIT_LAYOUTS = 6
// Which router a board build tries first: tscircuit's own (its layouts, Freerouting as the fallback), or Freerouting.
export const routerOrder = (): "tscircuit-first" | "freerouting-first" => (process.env.BRINGUP_ROUTER === "freerouting-first" ? "freerouting-first" : "tscircuit-first")

export { WAITING_ON_CONTRACT }

// A board that failed to route at its size, every layout tried, is recorded (recordRoutingFailure): the smallest board
// never offers that size, or one inside it, again. Only failures more room can fix (the router gave up, a trace past its
// length bound, parts or traces too close): not a design error such as a missing port, which no size changes.
export async function buildBoard(env: Env, dir: string, s: ContractSnapshot, revision: number): Promise<BoardArtifact> {
	// The backstop (lead-2, 26 Nov 2026): a 2-layer build that falls short is built once more on 4 layers, before the
	// architect is asked for a bigger board: ground on In1 and the wide rails on In2 leave the router's job (their pads are
	// stitched to the planes), so both copper and room come back. The design remembers it (boardLayers: "measured").
	// Three shortfalls count: a wide rail short on copper, connections left unconnected, a build that didn't route.
	const twoLayers = boardLayers(s).layers === 2
	const onFour = async (detail: string): Promise<BoardArtifact> => {
		recordLayerShortfall(s, detail)
		try {
			const work = `${dir}-4l`
			const b4 = await buildBoardAt(env, work, s, revision)
			rmSync(dir, { recursive: true, force: true })
			cpSync(work, dir, { recursive: true })
			rmSync(work, { recursive: true, force: true })
			const re = (p: string | null) => (p ? p.replace(work, dir) : p)
			return { ...b4, dir, pcbPath: re(b4.pcbPath)!, stepPath: re(b4.stepPath), renderPath: re(b4.renderPath), layers: 4, layersReason: { by: "measured", detail } }
		} catch (error) {
			forgetLayerShortfall(s)
			throw error
		}
	}
	let board: BoardArtifact
	try {
		board = await buildBoardAt(env, dir, s, revision)
	} catch (error) {
		const message = String(error instanceof Error ? error.message : error)
		const o = s.values.outline
		if (twoLayers && retryOnFour(message, freeroutingAvailable(env.root))) {
			try {
				return await onFour(`at 2 layers the board didn't route (rev ${revision}: ${message.split("\n").find((l) => /skipped|unrouted|Freerouting/.test(l))?.trim().slice(0, 160) ?? "build failed"})`)
			} catch {
				// Not on 4 either: the size is the architect's question, as before.
			}
		}
		if (o && sizeFailure(message)) recordRoutingFailure(s, o.widthMm, o.heightMm)
		throw error
	}
	// A 4-layer try that fails keeps the 2-layer board (its findings stand).
	const orTwo = (p: Promise<BoardArtifact>) => p.catch(() => board)
	if (twoLayers && board.narrowNets?.length)
		return orTwo(onFour(`at 2 layers ${board.narrowNets.map((n) => `${n.net} reached its ${n.needMm} mm on ${Math.round(n.atWidthMm)} of ${Math.round(n.totalMm)} mm`).join(", ")} (rev ${revision}): the rails ride a power layer`))
	if (twoLayers && (board.drc?.unconnected ?? 0) > 0)
		return orTwo(onFour(`at 2 layers ${board.drc!.unconnected} connection(s) stayed unconnected (rev ${revision}): ground and the wide rails move to planes`))
	const l = boardLayers(s)
	return l.layers === 4 ? { ...board, layers: 4, ...(l.reason ? { layersReason: l.reason } : {}) } : board
}

// A part tscircuit can't address (a pin name it can't select: lead-3's CNC mock 12, "Could not find port for selector
// '.J3 > .M+' ... It has no ports") leaves its traces missing too, but neither more room nor more layers fixes it: not a
// size failure, and no 4-layer retry (it built every failing revision twice).
const PART_ERROR = /Could not find port for selector|has no ports/
// A failure the placement check found before any layout was built (unreachableCaps: every layout leaves a capacitor out of
// reach) is the same cause tscircuit gives when it skips routing, and goes to the 4-layer retry and the bigger board the
// same way: the CNC's GND-end bound (27 Nov 2026) failed outright once the check measured it.
export const sizeFailure = (message: string): boolean => /^tscircuit build failed \((?:exit|placement check)/.test(message) && !PART_ERROR.test(message) && (ROUTING_FAILURE.test(message) || layoutSensitive(message))

// Whether a failed 2-layer build is worth a 4-layer one: a size failure, except a trace past its length bound with no
// Freerouting to route it. There the 4-layer retry has tscircuit's same bound and the same placement, and it never
// built (14 of 14 retries over six mock and real rover runs, 85 s each, 27 Nov 2026). With Freerouting it does: the
// CNC's bound failures route there on 4 layers.
export function retryOnFour(message: string, freerouting: boolean): boolean {
	if (!sizeFailure(message)) return false
	return freerouting || !(TOO_LONG.test(message) || BOUND_UNSATISFIED.test(message))
}

async function buildBoardAt(env: Env, dir: string, s: ContractSnapshot, revision: number): Promise<BoardArtifact> {
	// A pin on a part that isn't there yet would only fail in tscircuit ("Could not find port for selector"), slowly and
	// in its words: stop with the reason instead (the pin-part-missing check wakes the parts owner).
	// Connectors whose footprints overlap: tscircuit skips autorouting for the placement error, minutes in, and no layout
	// moves a connector (the architect places them). connector-clash names them; the build waits (real rover run 10).
	const clash = connectorClashes(s).filter((v) => / overlap on the board/.test(v.message))
	if (clash.length) throw new Error(`waiting on the contract: ${clash.map((v) => v.message).join("; ")}`)
	if (pinsWithoutMcu(s)) throw new Error("waiting on the contract: the pins are assigned but the parts list has no MCU yet; the board is built once it is there")
	const missing = pinPartsMissing(s)
	if (missing.length > 0) throw new Error(`waiting on the contract: ${missing.map((m) => `${m.signal} goes to ${m.ref}.${m.pin}`).join(", ")}, but there is no part ${[...new Set(missing.map((m) => m.ref))].join(", ")} yet; the board is built once it is there`)
	if (!env.tsci) throw new Error("tscircuit build failed: tsci is not installed (tools/node)")
	// tscircuit treats the nearest package.json as its project: inside this repo it would look for
	// react in our node_modules and write to the repo's dist/. Build outside any project, then copy.
	// tscircuit's autorouter occasionally drops a via onto a pad for one particular geometry; nudging the
	// LDO usually clears it, so a placement-sensitive failure retries with a few alternative distances.
	// The same goes for what only KiCad's DRC sees: tscircuit doesn't model a connector's locating-hole clearance, so a
	// via can land next to J1's NPTH (the first wake-word board: 4 hole_clearance errors, 0 on the logger without the
	// microphone). A build with DRC errors also tries the next distance; the build with the fewest errors is kept.
	let lastError: unknown
	let tried = 0
	let best: { board: BoardArtifact; errors: number; placement: PlacementOptions } | null = null
	// The default layout first; then the same with keepouts at the USB-C locating holes (the fix for vias beside
	// them); then the other LDO distances, each with and without the keepouts (the 60 mm logger with recovery pads,
	// 8 Nov: only 9.5 mm with keepouts built clean).
	const attempts: PlacementOptions[] = [{ ldoFromUsbMm: LDO_FROM_USB_MM }, { ldoFromUsbMm: LDO_FROM_USB_MM, usbKeepouts: true }, ...[7, 9.5, 11].flatMap((ldoFromUsbMm) => [{ ldoFromUsbMm }, { ldoFromUsbMm, usbKeepouts: true }])]
	// A layout that leaves a part out is never built: tscircuit would drop the part at the board's centre, onto whatever
	// is there (the wake-word board at 35×25 mm, LDO 11 mm from J1: "C3 overlaps U3", and autorouting skipped).
	const count = boardParts(s).length
	// The layouts with each SOT-23's pin parts beside their pins come after all the others, and only where they differ
	// (PlacementOptions.pinPads): a layout that routed before stays first.
	const withAlong = withPinPadLayouts(s, layoutAttempts(s, attempts))
	const placing = withAlong.filter((placement) => placeParts(s, placement).length >= count)
	// A layout with a pin capacitor out of its trace bound's reach is never built by tscircuit: it refuses it before
	// routing, and a build costs minutes (unreachableCaps). None left: Freerouting, which has no such bound, routes the
	// layout whose farthest capacitor is nearest (a rover's IMU capacitor at 5.00-5.09 mm in every layout, 26 Nov 2026:
	// before, tscircuit refused it and Freerouting routed it; failing outright would have stopped the run).
	let fitting = placing.filter((placement) => unreachableCaps(s, placement).length === 0)
	let reachError: Error | null = null
	if (placing.length && !fitting.length) {
		const far = unreachableCaps(s, placing[0])
		reachError = new Error(`tscircuit build failed (placement check, no layout built):\nAutorouting was skipped because ${far[0]}${far.length > 1 ? ` (${far.length - 1} additional violations)` : ""}. Every one of ${placing.length} layouts leaves a pin capacitor out of reach.`)
		const worst = (p: PlacementOptions) => Math.max(...unreachableCaps(s, p).map((m) => Number(/([\d.]+)mm apart/.exec(m)?.[1] ?? Infinity)))
		fitting = [placing.reduce((a, b) => (worst(b) < worst(a) ? b : a))]
	}
	if (fitting.length === 0) {
		const placed = new Set(placeParts(s).map((b) => b.ref))
		const left = boardParts(s).map((p) => p.ref).filter((ref) => !placed.has(ref))
		// The module alone, kept off its edge by connectors that can move along their edges: no room is not the answer,
		// moving them is (module-blocked). One that can't move along its edge leaves "no room" (a bigger board) standing.
		const mod = moduleBlocked(s)
		if (mod && moduleFreedAlongEdges(s) && left.every((r) => r === mod.ref))
			throw new Error(`waiting on the contract: ${mod.ref} (the radio module) goes on the ${mod.edge} edge and ${mod.blockers.join(", ")} ${mod.blockers.length === 1 ? "is" : "are"} in its way (module-blocked); the board is built once ${mod.blockers.length === 1 ? "it moves" : "they move"}`)
		throw new Error(`tscircuit build failed: no room on the board for ${left.join(", ")} at ${s.values.outline?.widthMm}×${s.values.outline?.heightMm} mm (the placer found no free spot)`)
	}
	// Last: the same layouts without the debug footprint, when none built with it (the rover at 42×29 mm: its five
	// lines left USB-C pins unrouted). A board never fails for want of a debug port; the report says it was left off.
	const withPort = debugPort(s).placed !== null
	let dropped = false
	let skipToNoPort = false
	// Layouts that fail outright tell us about this size, not this layout, after a couple: at most FAILED_PER_STAGE
	// failed builds with the port and as many without, then the error goes to the architect, who gives the board room.
	// (Walking all 16 layouts at ~50 s each took one STM32 board 10 minutes, 13 Nov.)
	let failedWith = 0
	let failedWithout = 0
	// tscircuit layouts that built with DRC errors or failed to build.
	let nonClean = 0
	// The layout just tried failed to build: its capsAlong variant, next in the list, gets its turn.
	let baseFailed = false
	// The first layout placed by tscircuit and routed by Freerouting (src/tools/freerouting.ts), for the boards tscircuit's
	// router can't finish: run 9's 58×22 rover routes there with its debug footprint kept, where tscircuit only built it
	// without (7 layouts, 16 Nov 2026).
	let freerouted = false
	let freeroutingError: string | undefined
	// A failure ending the search carries Freerouting's own reason too, when it ran and failed.
	const withFreerouting = (e: unknown): unknown => (freeroutingError && e instanceof Error && !e.message.includes(freeroutingError) ? new Error(`${e.message}\nFreerouting's layout: ${freeroutingError}`) : e)
	const viaFreerouting = async (placements: PlacementOptions[]) => {
		if (freerouted) return
		freerouted = true
		// No Freerouting here: its layout isn't built at all (it placed the board in tscircuit first, 12-13 s, only for the
		// route to fail: about 50 s of a free-tier rover run, 27 Nov 2026).
		if (!freeroutingAvailable(env.root)) {
			freeroutingError = `Freerouting: ${FREEROUTING_MISSING}`
			return
		}
		for (const placement of placements) {
			const work = mkdtempSync(join(tmpdir(), "bringup-board-"))
			const out = mkdtempSync(join(tmpdir(), "bringup-board-out-"))
			try {
				tried++
				const board = await buildIn(env, work, s, revision, out, { ...placement, routingDisabled: true })
				const errors = board.drc?.errors ?? 0
				// Over a tscircuit board with DRC errors only when it has fewer (it keeps that board's debug-footprint note).
				if (best && errors >= best.errors) { rmSync(out, { recursive: true, force: true }); return }
				const note = best ? best.board.debugPortDropped : placement.debugPort === false ? droppedWhy(lastError) : undefined
				if (best) rmSync(best.board.dir, { recursive: true, force: true })
				best = { board: { ...board, routedBy: "freerouting", ...(note ? { debugPortDropped: note } : {}) }, errors, placement }
				return
			} catch (error) {
				rmSync(out, { recursive: true, force: true })
				lastError = error instanceof Error ? new Error(error.message.replaceAll(out, dir)) : error
				// Its own log, layout-N-freerouting.log, and its reason kept for the final error: a later tscircuit layout's
				// failure overwrote it (the arm board, 26 Nov 2026: Freerouting's result was lost behind a cap bound).
				mkdirSync(dir, { recursive: true })
				writeFileSync(join(dir, `layout-${tried}-freerouting.log`), String(error instanceof Error ? error.message : error))
				// What it was given and what it routed, to see which connections it left (board.dsn, board.ses, its output).
				for (const f of ["board.dsn", "board.ses", "freerouting.log"]) if (existsSync(join(work, f))) cpSync(join(work, f), join(dir, `layout-${tried}-${f}`))
				freeroutingError = error instanceof Error ? error.message.replaceAll(out, dir) : String(error)
			} finally {
				rmSync(work, { recursive: true, force: true })
			}
		}
	}
	// Freerouting first (BRINGUP_ROUTER=freerouting-first, measured against tscircuit-first on every board fixture): the
	// first layout, placed by tscircuit and routed by Freerouting; clean, the search ends there.
	// A net wider than a track reaching a pin (a servo rail's 2.4 mm) routes at width only in Freerouting, which necks it
	// down at the pins: such a board goes there first too.
	if ((routerOrder() === "freerouting-first" || wideTracks(s).length) && fitting.length) await viaFreerouting([fitting[0]])
	// Every layout out of reach: Freerouting alone, on the nearest one.
	if (reachError) {
		await viaFreerouting(fitting)
		if (!best) throw withFreerouting(reachError)
	}
	for (const placement of reachError ? [] : withPort ? [...fitting, ...fitting.map((p) => ({ ...p, debugPort: false as const }))] : fitting) {
		if (best && best.errors === 0) break
		// A couple of tscircuit layouts not clean (built with DRC errors, or failed): Freerouting routes the best one's
		// placement (the first when none built), before more layouts are tried. Measured
		// 17 Nov 2026 on 12 boards: every board tscircuit routes clean does so within 2 layouts, and the crowded ones it can't
		// (run 14 rev 36) spent up to 7 layouts first.
		// Its result ends the search, as at the cap (more tscircuit layouts after it only cost time: the 60×21 rover went
		// from 3 layouts to 6 for the same 2 errors).
		if (nonClean >= LAYOUTS_BEFORE_FREEROUTING && !freerouted) {
			await viaFreerouting([best?.placement ?? fitting[0]])
			if (best) break
		}
		// Every layout with the debug footprint failed: Freerouting keeps the footprint before the layouts without it.
		if (placement.debugPort === false && !best && withPort) {
			await viaFreerouting([fitting[0]])
			if (best) break
		}
		// The search is bounded: past MAX_TSCIRCUIT_LAYOUTS builds, Freerouting routes the best placement so far and it ends.
		if (tried >= MAX_TSCIRCUIT_LAYOUTS) {
			if (!best || best.errors > 0) await viaFreerouting([best?.placement ?? fitting[0]])
			break
		}
		// Without the port only when no layout with it built clean (a board with DRC errors is worse than one without it).
		if (placement.debugPort === false && best && best.errors === 0) break
		// A failure that no other layout fixes (a trace the router couldn't place) goes straight to the boards without it.
		if (skipToNoPort && placement.debugPort !== false) continue
		// A retry (capsAlong, drawCaps) follows its own layout and doesn't count against the limit: it is that layout's next try
		// (the 42×29 rover with U5 turned 180° routes only as the keepout layout with its capacitors along their pads).
		const retry = !!(placement.capsAlong || placement.drawCaps)
		if (retry && !baseFailed) continue
		baseFailed = false
		if (!best && !retry && (placement.debugPort === false ? failedWithout : failedWith) >= FAILED_PER_STAGE) {
			if (placement.debugPort === false || !withPort) break
			continue
		}
		dropped = placement.debugPort === false
		const work = mkdtempSync(join(tmpdir(), "bringup-board-"))
		const out = mkdtempSync(join(tmpdir(), "bringup-board-out-"))
		try {
			tried++
			const board = await buildIn(env, work, s, revision, out, placement)
			const errors = board.drc?.errors ?? 0
			if (!best || errors < best.errors) {
				if (best) rmSync(best.board.dir, { recursive: true, force: true })
				const why: string = best ? `the board had ${best.errors} DRC error${best.errors === 1 ? "" : "s"} with it${best.board.drc?.firstError ? ` (${best.board.drc.firstError})` : ""}` : droppedWhy(lastError)
				best = { board: dropped ? { ...board, debugPortDropped: why } : board, errors, placement }
			} else rmSync(out, { recursive: true, force: true })
			if (errors === 0) break
			nonClean++
		} catch (error) {
			// The failed attempt's log goes to the run's folder, and the message points there. Not when an earlier layout
			// built: its board is what lands in the folder, and a failed layout's log beside it would mislead.
			if (!best && existsSync(join(out, "build.log"))) {
				mkdirSync(dir, { recursive: true })
				cpSync(join(out, "build.log"), join(dir, "build.log"))
			}
			// Every failed layout's own log too, as layout-N.log: a layout that failed after another built kept no detail (a
			// mock Eurobot at 64×45: "9 placement errors", and nothing said which, 17 Nov 2026).
			if (existsSync(join(out, "build.log"))) {
				mkdirSync(dir, { recursive: true })
				cpSync(join(out, "build.log"), join(dir, `layout-${tried}.log`))
			}
			rmSync(out, { recursive: true, force: true })
			lastError = error instanceof Error ? new Error(error.message.replaceAll(out, dir)) : error
			nonClean++
			// Once an earlier layout has built, a later one failing only means it isn't better: keep the board we have
			// (before, a keepout attempt that failed threw, and the built board with a few DRC errors was lost).
			// A failed retry leaves the layout failed: the next retry gets its turn.
			baseFailed = true
			if (retry) {
				// counted with its layout
			} else if (placement.debugPort === false) failedWithout++
			else failedWith++
			if (best) continue
			// The drawn-capacitor retry failing means this size is too tight around that part (real rover run 9 at 58×22 mm,
			// 16 Nov 2026): go straight to the boards without the debug footprint; and there, on a trace past its bound, stop:
			// the architect grows the board one step (run 9 at rev 24), cheaper than every layout left.
			// Measured: once the drawn retry fails at a size, for any reason (a trace past its bound, or the router's near-misses
			// the drawn traces cause), no later layout with the debug footprint has built (run 9's 58×22: 9 layouts, the
			// footprint left off in the end; the 60×21 rover alike).
			if (placement.drawCaps && withPort && placement.debugPort !== false) { skipToNoPort = true; continue }
			if (placement.drawCaps && TOO_LONG.test(String(error))) throw withFreerouting(error)
			// Layout-sensitive failures try the next layout; the router's junction tangle too (the STM32 logger: 38×22
			// fails, 38×21 routes, so a nudged LDO may clear it at the same size).
			if (!layoutSensitive(String(error))) {
				if (withPort && placement.debugPort !== false) { skipToNoPort = true; continue }
				throw withFreerouting(error)
			}
		} finally {
			rmSync(work, { recursive: true, force: true })
		}
	}
	// No tscircuit layout routed at all: Freerouting, without the footprint too if need be.
	if (!best && fitting.length) await viaFreerouting(withPort ? [fitting[0], { ...fitting[0], debugPort: false as const }] : [fitting[0]])
	// Every layout built with DRC errors: Freerouting routes the best one's placement, kept when it has fewer.
	else if (best && best.errors > 0) await viaFreerouting([best.placement])
	if (!best) throw withFreerouting(lastError)
	// Moved into the run's own folder, with every path re-pointed there.
	mkdirSync(dir, { recursive: true })
	cpSync(best.board.dir, dir, { recursive: true })
	rmSync(best.board.dir, { recursive: true, force: true })
	const at = (p: string | null) => (p ? p.replace(best!.board.dir, dir) : p)
	return { ...best.board, layoutsTried: tried, dir, pcbPath: at(best.board.pcbPath)!, stepPath: at(best.board.stepPath), renderPath: at(best.board.renderPath) }
}

// Each layout, then the same with its capacitor traces drawn (drawCaps), then with its pin capacitors allowed along
// their pads (capsAlong), when that differs: a default
// whose capacitor trace runs past its bound gets it as its next build. It builds with its own debug footprint spot and
// bottom pads (circuitFromContract passes capsAlong on); not for a design with a production test whose pads would
// move, since its fixture is built from the default layout's pads.
// The layouts with each SOT-23's pin parts beside their own pins, after all the others and only where they differ.
export function withPinPadLayouts(s: ContractSnapshot, plain: PlacementOptions[]): PlacementOptions[] {
	const sot = plain.map((p) => ({ ...p, pinPads: true })).filter((p) => JSON.stringify(layoutBoard(s, p).parts) !== JSON.stringify(layoutBoard(s, { ...p, pinPads: false }).parts))
	return [...plain, ...sot]
}

export function layoutAttempts(s: ContractSnapshot, attempts: PlacementOptions[]): PlacementOptions[] {
	return attempts.flatMap((p) => {
		const alt = { ...p, capsAlong: true }
		// First retry: the same layout with its capacitor traces drawn (capPaths), when it has any to draw; the router
		// can't run them long then (the 60×21 rover: no layout routed before, DRC 0 with them, 15 Nov 2026).
		const drawn = capPaths(s, p).length ? [{ ...p, drawCaps: true }] : []
		const same = JSON.stringify(layoutBoard(s, p).parts) === JSON.stringify(layoutBoard(s, alt).parts)
		const fixtureMoves = !!s.values.test && JSON.stringify(testPoints(s).placed) !== JSON.stringify(testPoints(s, { capsAlong: true }).placed)
		return same || fixtureMoves ? [p, ...drawn] : [p, ...drawn, alt]
	})
}

// tscircuit's own pictures of a built board (tsci snapshot): board.png (3D), board-pcb.svg and board-schematic.svg in
// the work dir. Best effort: a board without pictures is still a board.
export const SNAPSHOT_FILES = { "board.circuit-3d.snap.png": "board.png", "board.circuit-pcb.snap.svg": "board-pcb.svg", "board.circuit-schematic.snap.svg": "board-schematic.svg" } as const
export async function snapshotPictures(env: Env, work: string): Promise<string[]> {
	if (!env.tsci) return []
	const r = await run(env.tsci, ["snapshot", "board.circuit.tsx", "--update", "--3d"], { cwd: work, timeoutMs: 180_000, env: { PATH: toolPath(env) } })
	if (r.code !== 0) return []
	const out: string[] = []
	for (const [from, to] of Object.entries(SNAPSHOT_FILES)) {
		const f = join(work, "__snapshots__", from)
		if (existsSync(f)) {
			cpSync(f, join(work, to))
			out.push(to)
		}
	}
	rmSync(join(work, "__snapshots__"), { recursive: true, force: true })
	return out
}

async function buildIn(env: Env, work: string, s: ContractSnapshot, revision: number, dir: string, placement: PlacementOptions): Promise<BoardArtifact> {
	writeFileSync(join(work, "board.circuit.tsx"), circuitFromContract(s, placement))
	// tscircuit resolves react and its own packages from the work dir: linked to the repo's pinned install
	// (tools/node/node_modules), so a build needs no network and uses the versions the repo tested (a mock Eurobot's board
	// failed overnight on "DNSResolveFailed downloading package manifest react", 18 Nov 2026).
	const modules = env.nodeModules ?? join(env.root, "tools", "node", "node_modules")
	if (existsSync(modules) && !existsSync(join(work, "node_modules"))) symlinkSync(modules, join(work, "node_modules"), "dir")
	const build = await run(env.tsci!, ["build", "board.circuit.tsx", "--kicad-project"], { cwd: work, timeoutMs: 300_000, env: { PATH: toolPath(env) } })
	const circuitPath = join(work, "dist/board/circuit.json")
	// Placed only: Freerouting routes it (src/tools/freerouting.ts).
	if (placement.routingDisabled && build.code === 0 && existsSync(circuitPath)) {
		const why = await freeroute(env.root, work, "dist/board/kicad/board.kicad_pcb", new Map([...routedWidths(s, true)].filter(([n]) => !planeRails(s).includes(n))), boardLayers(s).layers === 4)
		if (why) {
			writeFileSync(join(dir, "build.log"), build.stdout + "\n" + build.stderr)
			throw new Error(`tscircuit build failed (exit 1):\nFreerouting: ${why}`)
		}
	}
	if (build.code !== 0 || !existsSync(circuitPath)) {
		writeFileSync(join(dir, "build.log"), build.stdout + "\n" + build.stderr)
		throw new Error(`tscircuit build failed (exit ${build.code}):\n${failureLines(circuitErrors(circuitPath), build.stdout + "\n" + build.stderr).join("\n")}\nfull log: ${join(dir, "build.log")}`)
	}
	const elements = JSON.parse(readFileSync(circuitPath, "utf8")) as { type: string; width?: number; height?: number }[]
	const pcb = elements.find((e) => e.type === "pcb_board")
	const pcbRel = "dist/board/kicad/board.kicad_pcb"
	// The routing keepouts were for the autorouter only; the board KiCad checks and exports is without them.
	const pcbFile = join(work, pcbRel)
	// A via the router dropped nearer the edge or an unplated hole than the fab allows moves clear, its traces' ends with
	// it (via-edge.ts);
	// the DRC below checks the result.
	if (existsSync(pcbFile)) writeFileSync(pcbFile, raiseSilkText(readFileSync(pcbFile, "utf8")))
	if (existsSync(pcbFile)) writeFileSync(pcbFile, nudgeVias(stripKeepouts(readFileSync(pcbFile, "utf8")), { edgeMm: FAB_RULES.minEdgeClearanceMm, holeMm: FAB_RULES.minHoleClearanceMm, holeToHoleMm: FAB_RULES.minHoleToHoleMm }).pcb)

	const step = await kicadCli(env, ["pcb", "export", "step", "-o", "board.step", pcbRel], work, 180_000)
	const render = await kicadCli(env, ["pcb", "render", "-o", "board.png", "--side", "top", pcbRel], work, 180_000)
	// Without KiCad (an npx install has no Docker image), tscircuit draws the board itself: a 3D view as board.png, the
	// PCB and the schematic as SVGs (setup streamlining, 26 Nov 2026: the free tier got no picture of its board).
	if (!(render.code === 0 && existsSync(join(work, "board.png")))) await snapshotPictures(env, work)
	const usbRefs = usbRefsOf(s)
	let drc = await runDrc(env, work, pcbRel, "dist/board/kicad/board.kicad_pro", usbRefs)
	// A reference designator on another outline, the edge or a pad: hidden on the silkscreen, then checked again (silk.ts).
	if (drc?.silkRefs?.length && existsSync(pcbFile)) {
		writeFileSync(pcbFile, hideReferences(readFileSync(pcbFile, "utf8"), drc.silkRefs))
		drc = await runDrc(env, work, pcbRel, "dist/board/kicad/board.kicad_pro", usbRefs)
	}
	// Pin labels that collide: alternate sides of the header; if they still do, the assembly drawing only.
	for (const fix of [alternatePinLabels, pinLabelsToFab]) {
		if (!drc?.labelRefs?.length || !existsSync(pcbFile)) break
		writeFileSync(pcbFile, fix(readFileSync(pcbFile, "utf8"), drc.labelRefs))
		drc = await runDrc(env, work, pcbRel, "dist/board/kicad/board.kicad_pro", usbRefs)
	}
	cpSync(work, dir, { recursive: true, filter: (src) => !src.endsWith("/node_modules") })
	// Each rail routed at its width, not the fab's default (only Freerouting routes a wide net at width; track-widths.ts).
	// A rail on a 4-layer board's power plane is judged by its region (planeNecks), not its track.
	const wide = new Map([...routedWidths(s, !!placement.routingDisabled)].filter(([n, w]) => w > DEFAULT_TRACE_MM && !planeRails(s).includes(n)))
	const narrow = wide.size && existsSync(pcbFile) ? narrowNets(netCopper(readFileSync(pcbFile, "utf8"), wide)) : []

	return {
		revision,
		dir,
		pcbPath: join(dir, pcbRel),
		stepPath: step.code === 0 && existsSync(join(dir, "board.step")) ? join(dir, "board.step") : null,
		renderPath: existsSync(join(dir, "board.png")) ? join(dir, "board.png") : null,
		widthMm: pcb?.width ?? 0,
		heightMm: pcb?.height ?? 0,
		nets: netsFromCircuitJson(elements),
		holes: holesFromCircuitJson(elements),
		parts: partsFromCircuitJson(elements),
		placements: placementsFromCircuitJson(elements),
		drc,
		...(narrow.length ? { narrowNets: narrow } : {}),
	}
}

// Keepouts are routing hints for tscircuit's autorouter (it can't see a connector's locating holes and drops vias next
// to them), not fab rules: KiCad would read them as rule areas and flag the connector's own pads inside. Removes every
// top-level zone that is a keepout from the exported board, leaving copper zones alone.
export function stripKeepouts(pcb: string): string {
	let out = ""
	let i = 0
	for (;;) {
		const at = pcb.indexOf("(zone", i)
		if (at < 0) return out + pcb.slice(i)
		let depth = 0
		let end = at
		for (; end < pcb.length; end++) {
			if (pcb[end] === "(") depth++
			else if (pcb[end] === ")" && --depth === 0) break
		}
		const block = pcb.slice(at, end + 1)
		const lineStart = pcb.lastIndexOf("\n", at) + 1
		out += pcb.slice(i, /\(keepout\b/.test(block) ? lineStart : end + 1)
		i = end + 1
	}
}

// tscircuit prints many advisory warnings before the real error; keep the lines that explain the failure.
// "cannot select a unique PCB port" is tscircuit failing to save its autorouter's paths for a junction: it shows on
// boards that build and route clean too (the rover at 42×29 and 50×29 mm, 15 Nov 2026), so it is never the cause.
const NOISE = /underspecified|requires_power|missing a trace|missing a manufacturer part|does not match supplier footprint|schematicsheet|is missing a name|Failed to load 3D model|unique PCB port/i
const SIGNAL = /error|overlap|clearance|too close|outside|fail|fatal|cannot|skipped|exceed/i
const SUMMARY = /^Circuits\s+\d+ passed \d+ failed/

// The lines that explain a failed build. The router's "missing a trace" lines also follow other errors (a via on a
// pad), so they count only when nothing more specific explains it: then the router ran out of room, and without them
// the architect saw only "0 passed 1 failed".
// A failure another layout of the same board may not have: parts or traces too close or overlapping, and a trace past
// its length bound (a pin's capacitor placed where its trace runs long). Not the router's port warning, which shows on
// clean builds too: it was the only reason a too-long trace got another layout before.
export const TOO_LONG = /exceeding the [\d.]+mm maximum/i
// tscircuit's (and the placement check's) refusal before routing: a bounded trace whose ends are already too far apart.
export const BOUND_UNSATISFIED = /[\d.]+mm maximum length for .* cannot be satisfied/
export function layoutSensitive(error: string): boolean {
	return /overlap|clearance|keepout|too close|exceeding the [\d.]+mm maximum|[\d.]+mm maximum length for .* cannot be satisfied/i.test(error)
}

// What a failed build says, cause first. tscircuit's own errors (circuit.json) lead, then the log's. But when it skipped
// autorouting for a placement error, every net it left unrouted is an error too, dozens of them, and they buried the
// cause past what the agents are shown (real rover run 10: "Courtyard of J2 overlaps with courtyard of J5", last):
// then the placement error and the skip lead, and the unrouted nets are left out.
export function failureLines(named: string[], log: string): string[] {
	const logged = buildErrors(log).split("\n").filter((l) => l && !named.some((n) => n.startsWith(l)))
	// Nothing taken for an error, yet the build failed: the traces the router left unrouted ("Trace [.U5 > .VM to .C6 >
	// .pin2] is not connected (it has no PCB trace)"), a few of them, so the failure reads as routing and the board's size
	// is recorded (the Eurobot base with servos at 60 × 40 mm, 17 Nov 2026: an empty message, no finding, the run stuck).
	if (!named.length && !logged.length) {
		const unrouted = log.split("\n").map((l) => l.trim()).filter((l) => /has no PCB trace/.test(l))
		if (unrouted.length) return [...unrouted.slice(0, 5), ...(unrouted.length > 5 ? [`and ${unrouted.length - 5} more traces with no PCB trace`] : [])]
	}
	if (!/Autorouting was skipped/i.test(log)) return [...named, ...logged]
	const lines = log.split("\n").map((l) => l.trim())
	const placement = lines.filter((l) => /overlaps? with|outside the board|Autorouting was skipped/i.test(l))
	const consequence = (l: string) => /not connected|missing a trace/i.test(l)
	return [...new Set([...placement, ...named.filter((l) => !consequence(l)), ...logged.filter((l) => !consequence(l))])]
}

// The errors tscircuit wrote into circuit.json, each once, a too-long trace with its name: a build can fail on one of
// these alone, with nothing in its log the filters above take for an error (a connector with no GND port: "exit 1 and no
// named error", 15 Nov 2026).
export function circuitErrors(file: string): string[] {
	if (!existsSync(file)) return []
	try {
		const elements = JSON.parse(readFileSync(file, "utf8")) as { type: string; message?: string; source_trace_id?: string; display_name?: string }[]
		const names = new Map(elements.filter((e) => e.type === "source_trace").map((e) => [e.source_trace_id, e.display_name]))
		const lines = elements.filter((e) => e.type.endsWith("_error") && e.message).map((e) => (e.source_trace_id && names.get(e.source_trace_id) ? `${e.message} (${names.get(e.source_trace_id)})` : e.message!))
		return [...new Set(lines)]
	} catch {
		return []
	}
}

// Why the debug footprint was left off: the pins the router left without a trace, or its first real error.
function droppedWhy(error: unknown): string {
	const lines = String(error).split("\n").map((l) => l.trim())
	const unrouted = lines.filter((l) => ROUTING_FAILURE.test(l)).map((l) => l.replace(/^Port (\S+) on (\S+) is missing a trace$/, "$2.$1"))
	if (unrouted.length) return `the board didn't route with it (no trace to ${unrouted.slice(0, 4).join(", ")}${unrouted.length > 4 ? ` and ${unrouted.length - 4} more` : ""})`
	const other = lines.find((l) => /exceeding the [\d.]+mm maximum|overlap|clearance/i.test(l))
	return `the board didn't route with it${other ? ` (${other})` : ""}`
}

export function buildErrors(output: string): string {
	const lines = output.split("\n").map((l) => l.trim()).filter(Boolean)
	const relevant = lines.filter((l) => SIGNAL.test(l) && !NOISE.test(l))
	if (relevant.every((l) => SUMMARY.test(l))) {
		const unrouted = lines.filter((l) => ROUTING_FAILURE.test(l))
		if (unrouted.length > 0) return [...unrouted.slice(0, 8), ...(unrouted.length > 8 ? [`(${unrouted.length - 8} more pins without a trace)`] : []), ...relevant].join("\n")
	}
	return (relevant.length > 0 ? relevant : lines).slice(-20).join("\n")
}

// The USB-C receptacles whose vendor land pattern the DRC exempts (drc.ts vendorLandPatternRules). The land pattern is the
// part's (role usb-c), whether or not the contract lists it among its connectors: run 17's rev-41 contract had no
// connectors field, and J1's own pads beside its locating holes counted as 2 DRC errors.
export function usbRefsOf(s: ContractSnapshot): string[] {
	return [...new Set([...(s.values.parts ?? []).filter((p) => p.role === "usb-c").map((p) => p.ref), ...(s.values.connectors ?? []).filter((c) => c.kind === "usb-c").map((c) => c.ref)])]
}
