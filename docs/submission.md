# Submission: Bringup

> For the 3ALET Hackathon, Freestyle track. Every claim below comes from a run in `docs/runs/`, from
> `docs/experiment.md`, or from the test suite, and the source is named next to it.

## Name

**Bringup**

## The one line

**Change one thing, and the whole hardware design follows: board, case, firmware and parts, in parallel, and still
consistent.**

## Description (about 150 words)

Move a connector five millimetres and three teams have work to do: the board, the case and the firmware. Hardware
bugs live in that gap. Bringup gives each domain its own agent and puts every fact in one live design contract, held
in Mozaik's shared `RuntimeState`. Agents run concurrently, each in its own `runLoop`.

When you change something mid-run ("make it 40 mm wide", "our sensor is out of stock"), Mozaik situations wake only
the agents it affects. They rework in parallel, and plain-code checks compare what was actually built until the design
is consistent again. No agent edits a field it doesn't own: Mozaik interception holds the call until the owner
approves.

Across 6 changes, the shared contract ended with 0 violations; with each team on its own copy, 16 mismatches would
have shipped. Each run produces printable case STLs, a JLCPCB fab package, firmware booted in QEMU, and a SPICE power
check, and a real ESP32-S3 runs the changed firmware.

## The demo (about 3 min, script in `docs/video.md`)

1. **The problem (20 s).** One change, three teams.
2. **The first design (30 s).** A brief goes in; nine participants work at once; the design settles.
3. **Change one thing (60 s).** "Make it 40 mm wide": only the outline changes; the architect, board, case and
   consistency check wake; parts, firmware build and grounding stay idle; the checks go red, then green; "Consistent
   again in …". The "What changed & why" drawer shows each write with its author's reason and its cause.
4. **The proof (30 s).** 0 violations against 16 mismatches.
5. **The real board (30 s).** "Blink faster when tilted" → the firmware rebuilds → the board is reflashed → tilted,
   it blinks at 244 ms, measured from its own telemetry, against the 250 ms the design asked for.

## Evidence

### The A/B experiment (`docs/experiment.md`, `npm run experiment`)

Scripted agents, real tools (tscircuit + KiCad, build123d, PlatformIO); one run per cell.

| Change | Shared contract: consistent again, agents woken, violations | Each team on its own copy: mismatches shipped |
|---|---|---|
| Board 10 mm narrower | 53 s · 2 of 7 · 0 | 4 (board holes and case standoffs no longer meet) |
| Board 6 mm taller | 31 s · 2 of 7 · 0 | 5 |
| USB-C to the bottom edge | 52 s · 2 of 7 · 0 | 1 (case cutout on the left, connector at the bottom) |
| Sensor I2C to GPIO4/5 | 72 s · 4 of 7 · 0 | 2 (the board's I2C nets miss the new pins) |
| Regulator swap to the XC6206 | 31 s · 3 of 7 · 0 | 1 (the board still places the old regulator) |
| Add a button | 68 s · 5 of 7 · 0 | 3 (no net, no part on the board, no hole in the case) |
| **Total** | **0** | **16** |

With the builders forced to take turns, the same changes took 36–94 s instead of 31–72 s.

### Real-model runs with mid-run changes

| Run | Change | Touched | Woke | Consistent again |
|---|---|---|---|---|
| `real-15` | make the board 40 mm wide | outline | architect, board, case, consistency (4 of 9) | 49 s |
| `real-15` | the SHT40 is out of stock | requirements, parts | architect, board, firmware, grounding, consistency (5 of 9) | 133 s, after a real `sensor-mismatch` (firmware still built for the old driver) was caught and cleared |
| `real-16` | make the board 40 mm wide | outline, connectors | architect, parts, board, case, consistency | 111 s: at 40 mm the button overlapped USB-C, so the architect moved the connectors |
| `real-17` | make the board 40 mm wide | outline, connectors | architect, board, case, consistency (4 of 9) | 224 s: the button ended up off the edge; the case and board failed until the connectors moved |

Full report, ripples and trace for real-15: `docs/runs/real-15/`.

### The real board (Act 3, `--bench real`)

The design settled and was flashed to an ESP32-S3 in 35 s; the LED blinked at 1000 ms (measured). "Blink faster when
tilted" set the firmware's behaviour field; rev 8 was flashed in 16 s and booted; tilted, it blinked at **244 ms
measured vs 250 ms** in the contract. The S3 dev board stands in for the design's C3.

## How it uses Mozaik

- **Situations are the dependency graph.** Each participant's `SituationSpecification` decides which events wake it,
  so a change to the outline wakes the board and the case and nothing else. Nothing orchestrates them
  (`src/change-control.ts`, `src/agents/builders.ts`).
- **Concurrency.** Four LLM agents (architect, parts, firmware reviewer, brief reviewer) and plain-code participants
  (three builders, consistency, grounding, the change desk, the bench) share one runtime. Every LLM turn is a
  fire-and-forget `runLoop` (`src/agents/common.ts`); the builders rebuild in parallel.
- **`RuntimeState` is the contract.** Fields have one owner and a version; concurrent writes to one field resolve to
  exactly one winner.
- **`InterceptionHandler` is change control.** A call to change another owner's field is held mid-loop until the owner
  decides; invalid proposals are returned with the reason before the owner is asked.
- **Humans and hardware are participants.** The engineer's change requests and the real board's telemetry are events
  like any other.
- **Mozaik 4.1 fixes:** an outbox gives every participant the same event order (#115); `safeRunLoop` reports crashed
  loops (#114).

## What one run hands you

Printable case and lid STLs with a print check; a JLCPCB fab package (Gerbers, drill, BOM, CPL, checklist); firmware
compiled against the real pin map and booted in QEMU; a SPICE simulation of the power rails, which the reviewer cites;
a routed KiCad board with DRC against JLCPCB's rules. The product firmware reads, stores a 30-day history on flash,
blinks 20 ms and deep-sleeps.

## Try it

```bash
git clone https://github.com/Laki4Ever79/bringup && cd bringup && npm ci
npm run bringup -- briefs/logger.md --mock --no-hardware --out out/quick   # about 10 s, no API key
npm run demo -- --no-hardware                                               # dashboard: settle, change, ripple
```

## Also in the repo (not in the talk)

Design tournament (`npm run tournament`), an MCP server for Claude Code and Cursor, an Ask box over a run's history,
mm rulers on the board view, and 614 tests.

## Limits, honestly

- **No real-model run has passed the final brief review yet.** Runs 15–17 took mid-run changes and ended with 0
  violations; the fresh-context reviewer still blocked on brief-vs-design arguments (battery life, LED behaviour,
  history depth).
- The experiment uses scripted agents (real tools); real-model change times vary from 49 s to 224 s.
- BLE is being added to the product firmware; QEMU can't test the deep-sleep wake.
- Boards need a human review before ordering (`fab/README.txt` lists every item).
- Proven on 40–70 × 30 mm boards with about 20 parts; the catalog is small.

## Prior art

Odem, MeshCue Forge, Copperhead, DRCY and Engineering Studio AI cover parts of this; tscircuit and KiCad do the real
EDA work. Flux described cross-domain change propagation as a vision (September 2026); Siemens Fuse orchestrates chip
and PCB tools. Bringup's addition is change propagation across board, case, firmware and parts, as Mozaik situations
over one owned, versioned contract, with a measured A/B.
