# Submission draft: Bringup

> Draft for the 3ALET Hackathon (Freestyle). Every claim below comes from a run report or trace in
> `agent-mesh/out/` or from the test suite, and the source is named next to it.

## Name

**Bringup**

## The one line

**A team of agents designs hardware around one shared contract, and every change is checked by someone other than the
agent who made it.**

The checkers, in order of how much we trust them:
1. **The owning agent.** Every contract field has one owner. A change to someone else's field is held mid-loop by Mozaik
   interception until the owner approves it (change control).
2. **Plain code.** Consistency checks compare what was actually built (board nets, case cutouts, the compiled pin map)
   with the contract. Grounding checks every pin against the parts catalog and KiCad's symbols.
3. **A fresh-context reviewer.** It judges the whole design against the original brief, with none of the history.
4. **The real board.** The bench, in progress; see Act 3.

## Description (about 150 words)

Hardware bugs live in the seams between disciplines: firmware on the wrong pin, a USB port that misses the case cutout,
a battery that dies in weeks instead of months. Bringup gives each discipline its own agent and puts every fact in one
live design contract, held in Mozaik's shared `RuntimeState`.

Agents run concurrently, each in its own `runLoop`, and a change wakes only the agents it affects. No agent checks its
own work. The field's owner approves cross-discipline changes through Mozaik interception. Plain code checks the real
board, case and firmware against the contract. A reviewer with a fresh context judges the result against the brief, and
it blocks the design until the agents fix what it finds.

Each run produces a routed KiCad board, a printable case, firmware that compiles (and boots in QEMU), a JLCPCB fab
package and an honest report, including the review findings that are still open.

## The story in three acts (about 3 min)

**Act 1: the problem (20 s).** Hardware bugs live in the seams. Each tool is right on its own, but the schematic, case,
firmware and power budget drift apart.

**Act 2: the team (90 s).**
- The brief goes in, and the architect, parts agent and firmware reviewer start at once. The board, case and firmware
  builders rebuild in parallel as the contract changes.
- **A held change.** The firmware agent needs a pin it doesn't own. In real run 8, at 715 s, it asked to add the USB
  pins for flashing ("requirements include USB firmware flashing"). Pins belong to the architect, so the call was held
  mid-loop and then approved at 720 s. In the mock demo, the same beat is a status-LED pin ("GPIO10 is free").
- **The engineer joins mid-run.** "Make the board 60 mm wide" changes the outline, which wakes only the board and case.
  Violations appear and clear.
- **The reviewer blocks, and the team fixes it.** In real run 8, review 2 failed the design for missing USB-C CC
  pull-down resistors (among other things). The architect then proposed adding them. That change was held, because the
  parts list belongs to the parts agent, and then approved, and the next review no longer raised it.

**Act 3: bring-up (60 s). Depends on the bench, which is still being designed (`docs/design/bench.md`).** A real
ESP32-S3 on the table runs the design's firmware. The measured current flows back into the contract, and the agents
react when it doesn't match their estimate.

**Fallback Act 3 (used if the bench isn't ready): the reviewer catches the agents gaming the numbers.**
- Run 7: unable to reach six months, the architect lowered `batteryLifeDays` to **60**. The reviewer blocked it: "the
  brief requires at least 6 months."
- Run 8: the team claimed **204 days** by assuming **0 µA** sleep current. The reviewer flagged that as "impossible".
- Run 6: the reviewer caught a bug in **our own battery calculator**. It counted only one rail of the battery current.
  We fixed it in `e904421`.

## Evidence (real-model runs)

| Run | Duration | Held changes (approved / rejected) | Violations caught, left | Reviews | Final review | Highlights |
|---|---|---|---|---|---|---|
| `real-6` | 487 s | 7 (5 / 2) | 11, 0 | 2 | fail | Reviewer found the calculator bug (VBAT 20 µA counted, the 3V3 rail's 0.106 mA missed). Fixed in `e904421` |
| `real-7` | 812 s | 18 (10 / 8) | 130, 0 | 3 | fail | Architect lowered the target to 60 days; reviewer blocked it. Final estimate 50 days against 180 |
| `real-8` | 967 s | 15 (14 / 1) | 104, 0 | 3 | fail | Agents chose the low-Iq XC6206, a TP4054 charger, a JST-PH battery connector and 5.1 kΩ CC resistors. Estimated 204 days, flagged for assuming 0 µA sleep. The firmware booted in QEMU at every revision from 8 to 42 |

**Honest status:** no real-model run has passed the final review yet. Each one ends with the review findings still
open, and the report lists them.
- **Mock runs settle every time.** The mock demo `out/demo-20261030-133550` (wt-firmware) applied the engineer's
  "60 mm wide" at 17 s and settled in 52 s.
- **The engineer's mid-run request hasn't been recorded in a real-model run yet.**
- **The reviewer only sees the contract, not the board.** In run 8 it kept reporting "no USB data path", because the
  board generator wires D± to the ESP32-C3's native USB itself, and the contract doesn't record that wiring.

## How the agents run concurrently (Mozaik)

- **Situations are the dependency graph.** Each participant's `SituationSpecification` decides which events wake it.
  Nothing orchestrates them (`src/agents/builders.ts`, `src/change-control.ts`).
- **Concurrent agents.** Four LLM agents (architect, parts, firmware reviewer, brief reviewer) and seven plain-code
  participants share one runtime (`src/run.ts`). Every LLM turn is a fire-and-forget `runLoop`
  (`src/agents/common.ts`).
- **Builders run in parallel**, each with its own `Rebuilder`, so a burst of changes collapses into one rebuild at the
  newest revision.
- **`InterceptionHandler` is change control**: it holds, approves or rejects calls to change another owner's field.
  Run 8 held 15 changes.
- **Mozaik 4.1 fixes:** an outbox gives every participant the same event order (#115), and `safeRunLoop` reports a
  crashed loop (#114).

## Try it (Node 24 only, about 5 s, no API key)

```bash
git clone https://github.com/Laki4Ever79/bringup && cd bringup && npm ci
npm run bringup -- briefs/logger.md --mock --no-hardware --out out/quick
cat out/quick/report.md
```

## Also in the repo (not in the talk)

- **Design tournament:** variants of a brief run as parallel processes and get ranked (`npm run tournament`).
- **MCP server:** start runs and read results from Claude Code or Cursor.
- **Fab package per run:** gerbers, drill, BOM with LCSC numbers, CPL, and a checklist.
- **QEMU boot of every new firmware**, when QEMU is installed.
- **`--no-hardware` stubs** for a Node-only look.
- **Live dashboard**, and 333 tests (all pass with the full toolchain and QEMU).

## Limits

- No real-model run has passed the final review yet (see Evidence).
- The bench (Act 3) is being designed; until it exists, the "real board" checker is QEMU only.
- The boards need a human review before ordering. `fab/README.txt` lists every item to check:
  - approximate module pad offsets
  - one wired module GND pad
  - no ground pour
  - stand-in footprints
- Proven on 45–70 × 30 mm boards with about 20 parts; the catalog is small (one MCU family).
