# Submission draft: Bringup

> Draft for the 3ALET Hackathon (Freestyle). Every number below comes from a run report in `out/`, a trace, or the
> test suite, and the source is named next to it. Update the numbers if a newer real run lands before 20:00.

## Name

**Bringup**

## One line

Concurrent Mozaik agents turn a one-page product brief into a hardware design whose board, enclosure and firmware agree
with each other, and keep them agreeing while the design changes.

## Description (about 150 words)

Small boards fail at bring-up for boring reasons: firmware on the wrong GPIO, a USB-C port that misses the case
cutout, an overloaded regulator. Bringup gives every domain its own agent and puts every
fact in one live design contract, held in Mozaik's shared `RuntimeState`. Each contract field has one owner and a version.

When a field changes, only the agents and builders that depend on it wake up. A routed PCB (tscircuit + KiCad), a 3D-printable
case (build123d) and firmware (PlatformIO) rebuild in parallel. Plain-code checks then compare what was actually built
against the contract. If an agent wants to change a field it doesn't own, Mozaik interception holds the call until the
owner, or the human engineer, approves it: engineering change control.

Each run ends with a consistency report, a JLCPCB fab package, and firmware compiled against the real pin map, which
boots in QEMU when that is installed.

## How the agents run concurrently

- **Situations are the dependency graph.** Each participant declares which events wake it (`SituationSpecification`).
  The enclosure builder only wakes for `outline` and `connectors`. The firmware builder only wakes for `parts` and
  `pins`. Nothing orchestrates them (`src/agents/builders.ts`, `src/change-control.ts`).
- **Fire-and-forget turns.** Every LLM turn is its own `runLoop` (`src/agents/common.ts`), so the architect, parts
  agent, firmware reviewer and brief reviewer can all be mid-turn at once. Four LLM agents and seven plain-code
  participants share one runtime (`src/run.ts`).
- **Builders in parallel, each with its own `Rebuilder`.** A build in flight finishes, and a burst of changes collapses
  into exactly one rebuild at the newest revision (`src/tools/rebuilder.ts`). In real run `out/real-2`, board, enclosure
  and firmware builds interleave in the trace, e.g. firmware rev 5 at 35 s and board rev 5 at 39 s.
- **Interception holds cross-owner changes.** For example, the firmware agent asks to add `STATUS_LED` to `pins`, which
  the architect owns. The call is held mid-loop; it resumes when the owner approves, or returns to the model with the
  rejection (`src/change-control.ts`). The engineer can vote too.
- **The emulator check boots each new firmware in QEMU** while the other builds run. Boots coalesce the same way builds
  do, and it never holds up settling, because it isn't an artifact (`src/agents/emulator.ts`).
- **Tournaments run whole designs in parallel processes** and rank them (`npm run tournament`).
- **Mozaik 4.1 fixes:** an outbox gives every participant the same event order (#115), and `safeRunLoop` reports a
  crashed loop instead of hiding it (#114).

### Numbers from our runs

| Run | Models | Result | Wall time | Contract revisions | Held by interception | Violations caught on the way |
|---|---|---|---|---|---|---|
| `out/real-2` | real | settled, 0 violations | 187 s | 13 | 7 (6 approved, 1 rejected) | 39 |
| `out/real-4` | real | settled, 0 violations | 192 s | 13 | 2 (2 approved) | 57 |
| `out/demo-20261030-133550` | mock | settled, 0 violations; mid-run "make the board 60 mm wide" applied at 17 s | 52 s | 8 | 1 (approved) | 3 |
| tournament, 4 variants | mock | all 4 settled | 78 s total | — | — | — |
| `out/boot-1` (wt-firmware) | mock | settled, 0 violations; firmware revs 6 and 7 booted in QEMU (at 8.8 s and 17.7 s), report: "booted, printed revision 7" | 44 s | 7 | 1 (approved) | 2 |

Honest count: of the 5 real-model runs we kept, **2 settled** (`real-2`, `real-4`).
- `real-1` and `real-3` stopped on board-build failures, which the placement work fixed afterwards.
- In `review-real-2` (wt-enclosure), the brief reviewer returned **fail**: no charger, no CC resistors, no USB data
  lines, and an impossible battery budget. Those blockers are why the catalog now has a Li-ion charger, a battery
  connector, CC resistors and USB D± wiring.
- All real runs predate that completed catalog. A real run on the current build has not been recorded yet.

`npm test`: 295 tests pass, 0 skipped, when the full toolchain and QEMU are installed.

## What's new compared with prior art

Cross-domain DRC (MeshCue Forge, Odem), datasheet-grounded review (DRCY), gated KiCad agents (Copperhead) and parallel
engineering agents (Engineering Studio AI) already exist, and the README credits them. What Bringup adds:
- the checks run **live, as events that wake only the affected agents**, not as a final pipeline stage
- contract fields have **owners and versions**, and cross-owner edits go through **change control built on Mozaik
  interception**, with the human engineer as a voting participant
- **whole-design tournaments** run as parallel processes
- every run ends in **artifacts you can open**: KiCad project, STEP/STL case, compiled firmware, and a JLCPCB fab
  package (gerbers, drill, BOM with LCSC numbers, CPL). With the optional Espressif QEMU installed, every run also
  boots its newest firmware headless and reports the contract revision the firmware printed (`firmware.booted`)

## Try it (Quick look: Node 24 only, about 5 s, no API key)

```bash
git clone https://github.com/Laki4Ever79/bringup && cd bringup && npm ci
npm run bringup -- briefs/logger.md --mock --no-hardware --out out/quick
cat out/quick/report.md
```

With the full toolchain (README, "Install"):
- `npm run bringup -- briefs/logger.md --mock` builds the real board, case and firmware in about 35 s.
- `npm run demo -- --mock` adds the live dashboard and a scheduled mid-run change request.

## Limits

- **Boards need a human review before ordering.** `fab/README.txt` lists every item to check:
  - the ESP32-C3 module's land pattern has approximate pad offsets, and only one of its GND pads is wired
  - there's no ground pour
  - the SHT40 and the button use stand-in footprints
  - the charger's pin order comes from a pin-compatible part
- **Proven on small boards only:** 45–70 × 30 mm, about 20 parts.
- **The catalog is small** (one MCU family). Agents can only choose vetted parts, though stock and prices are live.
- **Real-model runs settle less often than mock runs** (2 of 5 kept runs). The run report always says why one didn't.
