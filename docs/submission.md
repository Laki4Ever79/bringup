# Submission: Bringup

> For the 3ALET Hackathon, Freestyle track. Every claim below comes from a run in `docs/runs/`, from
> `docs/experiment.md`, or from the test suite, and the source is named next to it.

## Video

https://youtu.be/b0B6R5KyZ64 (3 min)

## Name

**Bringup**

## The one line

**Change “one thing”, and the whole hardware design follows: board, case, firmware and parts, in parallel.**

## Live deployment

https://bringup-demo.onrender.com/: a read-only dashboard of the recorded runs (add a sensor, the real-model runs, the
linked git folder…); the first load after idle takes about 30 s. The recorded runs used the real tools; live runs
there are stubbed. Or press **Try it**: a stubbed scripted run you can change once. Other write actions are refused.

## Description (about 150 words)

Add a sensor to a device, and four teams have work to do: the parts list, the board, the firmware and the case.
Hardware bugs live in the gaps between them. Bringup gives each domain its own agent and puts every fact in one live
design contract, held in Mozaik's shared `RuntimeState`. Agents run concurrently, each in its own `runLoop`. Even
designing from scratch is just the first change: Bringup builds the first design from a short brief the same way.

When you change something ("add a temperature/humidity sensor", "make it 40 mm wide"), or simply edit and save a
generated file (the firmware's `pins.h`, the board in KiCad), Mozaik situations wake only the agents it affects. They
rework in parallel, and plain-code checks compare what was actually built until the design is consistent again: in
the add-a-sensor run, 7 of 9 agents woke, 9 mismatches were caught, and the case grew a vent over the new sensor. No
agent edits a field it doesn't own: Mozaik interception holds the call until the owner approves.

Across 6 changes, the shared contract ended with 0 violations, consistent again in 31–72 s with builds in parallel (36–94 s
one at a time); a simulated baseline where each team keeps its own stale copy would have shipped 16 mismatches. Each run produces printable case STLs, a JLCPCB fab package, firmware booted in QEMU, and a SPICE power
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

| Run | Change | Touched | Woke (of 9) | Consistent again |
|---|---|---|---|---|
| `real-20` | "our temperature/humidity sensor is out of stock; switch to the other one" | parts | parts, board, firmware build, grounding, consistency (5); the case stayed idle | 75 s, after a `sensor-mismatch` and a `part-mismatch` were caught and cleared |
| `real-20` | "make the board 40 mm wide" | outline | architect, board, case, consistency (4) | 28 s |
| `real-19` | the same sensor swap | parts | 6; the case stayed idle | 52 s, after a `sensor-mismatch` (firmware still built for the old driver) was caught and cleared |
| `real-19` | "make the board 40 mm wide" | outline, connectors | 5 | 102 s: the first 40 mm board failed, so the architect moved the connectors |
| `real-15` | "make the board 40 mm wide" | outline | 4 | 49 s |

Each of these changes ended with 0 violations. Reports, ripples and full traces: `docs/runs/real-15/`, `real-19/`,
`real-20/`.

**Add a sensor with real models** (`docs/runs/add-sensor-real-2/`): 7 of 9 woke, consistent again in 79 s. An engineer's
request now amends the brief, so the reviewer stopped calling the sensor out of scope and made the agents wire it (I2C
on GPIO6/7). The parts agent had already added a sensor before the request, against the beacon brief; the request made
it legitimate. The run still ended unsettled (battery life).

### The real board (Act 3, `--bench real`)

The design settled and was flashed to an ESP32-S3 in 35 s; the LED blinked at 1000 ms (measured). "Blink faster when
tilted" set the firmware's behaviour field; rev 8 was flashed in 16 s and booted; tilted, it blinked at **244 ms
measured vs 250 ms** in the contract. The S3 dev board stands in for the design's C3.

### Add a sensor (`docs/runs/add-sensor/`, scripted agents, real tools)

A pocket BLE beacon with no sensor (`briefs/beacon.md`) was designed first (consistent in 263 s). Then "add a
temperature/humidity sensor": parts added the SHT40 and its pull-ups, the architect wired it to GPIO8/GPIO9, the board
re-placed and re-routed, the firmware switched on its driver, and the case cut a vent in the lid over the sensor. 7 of
9 agents woke; 9 conflicts were caught live (including "case has no vent over the sensor U2"); consistent again in
195 s with 0 left.

### Simulated with its sensor (`docs/runs/wokwi/`, optional)

After "add a temperature/humidity sensor", `npm run bringup -- simulate <runDir>` ran the new firmware in Wokwi on a
circuit generated from the contract (the ESP32-C3 plus the chosen sensor on the assigned pins): `SENSOR OK 21.50 C
48.0 %RH`, and the reading was stored. The firmware the agents generated reads the sensor they chose, on the pins they
assigned. The sensor is a stand-in chip with fixed values; simulation runs on demand (free plan: 50 min a month).

### Edit the file instead (`docs/runs/file-sync/`)

A save of a generated file becomes the engineer's change request and goes through the same change control. Scripted
agents, real tools; tests in `test/file-sync.test.ts` and `test/file-sync.int.test.ts`.

| Saved | Became | Woke (of 9) | Consistent again |
|---|---|---|---|
| `pins.h`: `PIN_I2C_SDA 8` → `4` | "edited pins.h: I2C_SDA GPIO8 → GPIO4", 0.3 s after the save | 5; the case stayed idle | 96 s: the firmware rebuilt on GPIO4 and booted in QEMU, the board rebuilt DRC-clean |
| `board.kicad_pcb`: right edge dragged out 5 mm | "edited board.kicad_pcb: outline 50×30 → 55×30 mm" | 4; firmware build and grounding stayed idle | 21 s |

An edit the contract doesn't cover gets a drift warning ("this edit isn't in the design contract; the next rebuild
will overwrite it"), and a save against an old revision is refused. Connector moves are mapped and unit-tested; only
the outline was run end to end with real tools.

**A linked folder is a git repo** (`docs/runs/linked/`, scripted agents, real tools; `test/linked.test.ts`): every
settled revision is a commit whose message is the ripple. A `pins.h` edit was adopted (125 s); an edit to an older
`pins.h` made while the design had moved was rebased instead of refused (45 s); a KiCad re-save with the same design was
classified "re-saved, no design change". Commits are local only. With real models (`docs/runs/file-sync/real/`), a
`pins.h` edit was applied 5 s after the save and kept, though that run then ended unsettled.

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

**Approvals where you are.** A change held for the engineer can be pushed to a phone through ntfy, with Approve and
Reject buttons that decide it like the dashboard's: opt-in, only the field and a one-line reason in the push, a
token-guarded route from the network. Built and tested; not yet tried on a real phone (`docs/design/phone-approvals.md`).

## What one run hands you

Printable case and lid STLs with a print check; a JLCPCB fab package (Gerbers, drill, BOM, CPL, checklist); firmware
compiled against the real pin map and booted in QEMU; a SPICE simulation of the power rails, which the reviewer cites;
a routed KiCad board with DRC against JLCPCB's rules. The product firmware reads, stores a 30-day history on flash,
blinks 20 ms, advertises over BLE for the rest of its wake window, and deep-sleeps.

**Ready to order in one click.** On a fully green run (settled, consistent, real hardware, DRC clean, review passed), a
"Ready to order ↗" button downloads one zip with the exact files JLCPCB asks for (`gerbers.zip`, `bom.csv`, `cpl.csv`),
the case and lid STLs for JLC3DP, and a README with the steps and a "before you pay" checklist, and opens JLCPCB's quote
page. Nothing is uploaded and no order is placed (`test/order.test.ts`).

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

- **One real-model run has passed the final brief review** (docs/runs/real-pass: settled at rev 19, passed review 2), after the night's real runs were used to find and fix general problems; each real run surfaced a concrete blocker and each fix removed it for every later run; a few known blockers remain; earlier real runs ended with 0 violations but failed review. Battery life is computed from datasheet currents, not measured.
- The experiment uses scripted agents (real tools); real-model change times vary from 28 s to 224 s.
- BLE was verified on an ESP32-S3 dev board (advertising, reading the latest record and the history), not on the C3 design; QEMU can't test the deep-sleep wake.
- Boards need a human review before ordering (`fab/README.txt` lists every item).
- Proven on 40–70 × 30 mm boards with about 20 parts; the catalog is small.

## Prior art

Odem, MeshCue Forge, Copperhead, DRCY and Engineering Studio AI cover parts of this; tscircuit and KiCad do the real
EDA work. Flux described cross-domain change propagation as a vision (September 2026); Siemens Fuse orchestrates chip
and PCB tools. Bringup's addition is change propagation across board, case, firmware and parts, as Mozaik situations
over one owned, versioned contract, with a measured A/B.
