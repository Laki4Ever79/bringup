# Bringup

**Change one thing, and the whole hardware design follows: board, case, firmware and parts, in parallel, and still
consistent.**

> **Quick look: needs only Node 24, no API key; about 1 min for `npm ci`, then about 10 s.**
> ```bash
> git clone https://github.com/Laki4Ever79/bringup && cd bringup && npm ci
> npm run bringup -- briefs/logger.md --mock --no-hardware --out out/quick
> cat out/quick/report.md   # "settled ... Violations: 0", plus the change requests held by interception
> ```

Concurrent Mozaik agents turn a short product brief into in-stock parts, a
routed PCB, a printable case whose cutouts match the board, and firmware that compiles against the real pin map. Then
you change one thing ("make it 40 mm wide", "the sensor is out of stock", "blink faster when tilted"). Only the agents
that change affects wake up, rework their part at the same time, and the design is consistent again, with every
other part left alone.

**What one run hands you, ready for a prototype:**

| Output | Ready for | Where |
|---|---|---|
| Printable case and lid (`case.stl`, `lid.stl`, plus STEP), with a print check (minimum wall 1.6 mm, lid clearance, print orientation) and M2 standoffs that line up with the board's holes | Your own 3D printer today, or a print service | `out/<run>/enclosure/rev-N/` |
| Fab package in JLCPCB's assembly format (Gerbers + drill, `bom.csv`, `cpl.csv`, a pre-order checklist), every part an LCSC number, with stock checked live in real-model runs | Ordering the assembled PCB, with the case ordered alongside | `out/<run>/fab/` |
| Firmware, compiled against the board's actual pin map, then **booted in QEMU** (Espressif's ESP32-C3 emulator) at every revision | Flashing the real board | `out/<run>/firmware/rev-N/` |
| **SPICE power simulation** (ngspice): each regulator's output under load at the battery's low end, fed to the reviewer, which cites it (e.g. "3.277 V at 3.5 V battery, −23 mV headroom") | Catching a brown-out before it reaches a prototype | `report.md` |
| Routed KiCad board, DRC against JLCPCB's rules, a 3D render | Review in KiCad | `out/<run>/board/rev-N/` |

Every change re-makes the affected outputs: a narrower board means a new case STL, new Gerbers and new standoffs, and
nothing else.

## The proof: one change, with and without the shared contract

We applied 6 real changes to a settled design twice (`npm run experiment`, [docs/experiment.md](docs/experiment.md)).
In arm A the agents share one live design contract and Mozaik situations wake the affected ones. In arm B only the
domain that heard the change updates, and every other team keeps working from its own copy. The same plain-code checks
then compare what was actually built:

| Change | With the shared contract | Each team on its own copy: mismatches that would ship |
|---|---|---|
| Board 10 mm narrower | consistent again in 53 s · 2 of 7 woke · 0 violations | 4: two board holes have no standoff under them, two standoffs have no hole |
| Board 6 mm taller | 31 s · 2 of 7 · 0 | 5: the board is 50×30 mm, the contract says 50×36 mm, and 4 hole/standoff misses |
| USB-C to the bottom edge | 52 s · 2 of 7 · 0 | 1: the case cutout for J1 is left@15 mm, the connector is bottom@25 mm |
| Sensor I2C to GPIO4/5 | 72 s · 4 of 7 · 0 | 2: the board's I2C_SDA and I2C_SCL nets don't reach GPIO4 and GPIO5 |
| Swap the regulator for a low-Iq XC6206 | 31 s · 3 of 7 · 0 | 1: the board still places the AP2112K as U3, the contract says XC6206 |
| Add a button | 68 s · 5 of 7 · 0 | 3: the BUTTON net doesn't reach GPIO3 or SW1, the board has no SW1, and the case has no hole for it |
| **Total** | **0 violations** | **16 mismatches** |

The agents are scripted (the keyless mock models) and the tools are real: tscircuit + KiCad, build123d, PlatformIO.
Each cell is one run on one laptop, with other jobs sharing the CPU, so read the times as tens of seconds. With the
builders made to take turns instead of running in parallel, the same changes took 36–94 s instead of 31–72 s. The
regulator swap was added once a check compared the board's actual parts with the parts list; before that, it would
have scored 0 by not looking.

3ALET Hackathon 2026, Freestyle track. Built on `@mozaik-ai/core` 4.1.0.

> **Status, honestly.** Scripted runs settle with 0 violations and take mid-run changes, with real board, case and
> firmware builds (and a QEMU boot when QEMU is installed). **Real models took mid-run changes too** in real run 15:
> "make the board 40 mm wide" touched only the outline and was consistent again in 49 s (architect, board, case and
> consistency worked; parts, firmware build and grounding stayed idle), and "the SHT40 is out of stock" swapped in the
> SHTC3, tripped a real `sensor-mismatch` (firmware still built for the old driver) and was consistent again in 133 s.
> That run still **did not pass the final brief review** (a charge-LED blocker and battery life), and no real-model run
> has yet. See `docs/runs/real-15/` (report, ripples, trace) and `docs/submission.md`. This README does not claim results that haven't run.

## Every change has a checker other than its author

1. **The field's owner** approves or rejects it, through Mozaik interception (change control). An invalid proposal is
   returned with the reason before the owner is ever asked.
2. **Plain code** checks what was actually built, and grounds every pin in the catalog and KiCad's symbols.
3. **A fresh-context reviewer** judges the design against the brief.
4. **The real board**: an ESP32-S3 on the bench runs the design's firmware and reports back (`--bench real`).

## The problem

A small board fails at bring-up for boring reasons, and they all come from domains drifting apart:

- **Pin drift.** The schematic routes the sensor to GPIO8, but the firmware still says GPIO4.
- **Fit.** The board grows 2 mm, and the USB-C cutout in the case no longer lines up.
- **Power.** A part is added, and the 3.3 V regulator is now over its current budget.
- **Parts.** The chosen part is out of stock, and its replacement has a different pinout.

Today a human keeps these in sync by hand. In Bringup, each domain is an agent, every fact lives in **one live design
contract**, and a change in one domain wakes exactly the agents it affects.

## Architecture

```
                      engineer (human: brief, mid-run change requests)
                                     │
                                     ▼
   ┌───────────┐   ┌──────────────── DesignContract ─────────────────┐   ┌───────────┐
   │ architect │◀─▶│ requirements · outline · connectors · rails ·   │◀─▶│   parts   │
   │   (LLM)   │   │ parts · pins   (owner + version per field)      │   │   (LLM)   │
   └───────────┘   │          held in Mozaik RuntimeState            │   └───────────┘
                   └──────▲───────────────▲───────────────▲──────────┘
             contract.changed      contract.changed      contract.changed
                   ┌──────┴────┐   ┌──────┴──────┐   ┌────┴──────┐
                   │   board   │   │  enclosure  │   │ firmware  │
                   │ tscircuit │   │  build123d  │   │PlatformIO │
                   │  + KiCad  │   │             │   │  (+QEMU)  │
                   └──────┬────┘   └──────┬──────┘   └────┬──────┘
                          └─ artifact.ready / artifact.failed ┘
                                         ▼
                         consistency (plain code, no LLM)
                    consistency.checked ──▶ wakes the affected agents
                    design.ready        ──▶ brief reviewer (LLM, fresh context)
                    review.completed    ──▶ fail: findings to the field owners
                    design.settled      ──▶ report.md
```

There is no orchestrator: no agent calls or awaits another. Agents coordinate only through events and the contract.
The full diagram is in the [plan doc](https://claude.ai/artifact/GpFMaa2NAE81hn9BSHajQj).

**The contract** (`src/contract/contract.ts`). Each field has one owning role (`parts` owns `parts`, `architect` owns
the rest) and a version. A write must name the version it was based on, so when two agents write the same field at
once, exactly one applies and the other gets `stale` and re-reads.

**Events** (`src/events.ts`):

| Event | Meaning |
|---|---|
| `contract.changed` | A field got a new version (field, version, revision, by whom) |
| `change.proposed` | A non-owner asked to change a field; its loop is held |
| `change.decided` | The owner approved or rejected it |
| `artifact.ready` / `artifact.failed` | A board, enclosure or firmware build finished for a revision |
| `consistency.checked` | Cross-domain check result, with each violation's `affects` roles |
| `grounding.checked` | Part pins and pin assignments checked against the catalog and KiCad symbols |
| `design.ready` | The design is consistent and quiet; the brief reviewer judges it before it settles |
| `review.completed` | The reviewer's verdict (`pass`/`fail`) with findings, each naming the contract fields it concerns |
| `design.settled` | Every artifact is built against the latest revision with no violations, and the review is done |
| `agent.halted` | An agent loop crashed (Mozaik #114 workaround) |

**Cross-domain checks** (`src/contract/consistency.ts`): `outline-mismatch`, `net-missing`, `pin-mismatch`,
`cutout-missing`, `cutout-misaligned`, `rail-overload`, `firmware-build-failed`. Each check reads the artifacts that
were actually built. For example, the firmware's pins are parsed back out of the `pins.h` it compiled.

### Three checks

| Check | What it compares | What it catches | How |
|---|---|---|---|
| **Consistency** (`src/contract/consistency.ts`) | The built artifacts against the contract | A board whose nets miss a pin assignment, a case cutout that misses the USB-C port, firmware built for another pin map, an overloaded rail | Plain code, after every build |
| **Grounding** (`src/agents/grounding-check.ts`) | The contract against the parts catalog and KiCad 10's symbol library | Invented pinouts: a pin a part does not have, a GPIO the MCU lacks, a part no source knows | Plain code, after every parts or pins change |
| **Brief reviewer** (`src/agents/reviewer.ts`) | The final design against the brief | A must-have the design does not meet, battery-life arithmetic that does not add up, a part choice that undermines the goal (for example an LDO's quiescent current against a 6-month target) | An LLM in a fresh context. It sees only the brief, the contract and the check results, never the agents' turns. |

The first two keep the design self-consistent and real. Neither asks whether it is the *right* design, so the
reviewer is the final gate. When the design is consistent and quiet, the consistency participant emits
`design.ready` instead of settling. The reviewer answers with `review.completed`. A pass settles. A fail sends each
finding to the owner of the fields it names and re-reviews the changed design. After one fix round (`maxReviewRounds`)
the run settles anyway, with the findings in `report.md`, and it is unsettled only if a blocker remains. `--no-review`
turns the gate off.

## How it uses Mozaik

| Mozaik feature | How Bringup uses it | Where |
|---|---|---|
| `SituationSpecification` + processor | Each participant's situations decide which events wake it, so **the situations are the dependency graph between domains** | `src/change-control.ts` (`when`, `ownerReviewsChanges`) |
| `runLoop` (fire-and-forget) | Every agent turn is its own loop, so agents run concurrently; each turn starts from a fresh context | `src/agents/common.ts` (`startTurn`) |
| `RuntimeState` | `BringupState` holds the contract, artifacts, roles and open approvals: one shared state per run | `src/runtime.ts` |
| `InterceptionHandler` | **Change control**: a `propose_contract_change` call on a field the agent doesn't own is held mid-loop until the owner decides; rejections go back to the model as the tool output | `src/change-control.ts` (`ChangeControl`) |
| `createHuman` | Plain-code participants with no LLM: the change desk routes decisions to held loops, the consistency checker, the grounding critic, the three builders, and the engineer who sends the brief | `src/change-control.ts`, `src/agents/consistency.ts`, `src/agents/critic.ts`, `src/agents/builders.ts`, `src/run.ts` |
| Custom `InferenceRunner` | Per-role models (strong for architect, fast for the rest). `--mock` swaps in a scripted runner, so a full run needs no key | `src/inference/models.ts`, `src/inference/scripted-runner.ts` |

Workarounds for known 4.1 bugs:

- **#115** (`publish` is re-entrant, so participants can see events in different orders): every custom event goes
  through an `Outbox` that delivers one event at a time and writes `trace.jsonl`. See `src/outbox.ts`.
- **#114** (`runLoop` swallows errors, so a crashed agent looks idle): `safeRunLoop` turns failures into
  `agent.halted`. See `src/runtime.ts`.
- **#113** (an interception returning `idle` crashes): `ChangeControl` never returns `idle`.

Long tool runs are coalesced per artifact by `Rebuilder` (`src/tools/rebuilder.ts`). There is one build at a time; if
the inputs change mid-build, exactly one more build runs at the newest revision.

## Install

The Quick look above needs only Node. The full toolchain adds real board, enclosure and firmware builds.

| Prerequisite | Tested with | Notes |
|---|---|---|
| Linux x86-64 (macOS should work, but is untested) | Ubuntu, kernel 7.0 | |
| Node 24 + npm | Node 24.0.2, npm 11.3.0 | the only requirement for `--no-hardware` |
| [uv](https://docs.astral.sh/uv/) + Python 3.12 | uv 0.10.2, CPython 3.12.3 | for build123d and PlatformIO |
| Docker, with the daemon running and usable without `sudo` | Docker 29.6.1 | for KiCad and ngspice |
| Disk | about 7 GB | `.venv` 1.1 GB, `tools/node` 0.8 GB, KiCad image 2.6 GB (0.8 GB download), ESP32-C3 toolchain about 2.8 GB in `~/.platformio` |
| Java 17+ (optional) | | only for the Freerouting fallback |

```bash
npm ci
uv venv --python 3.12 .venv && uv pip install platformio==6.2.0 build123d==0.13.0
npm i --prefix tools/node tscircuit@0.0.3042 bun@1.4.4    # pinned: tscircuit releases daily
docker pull kicad/kicad:10.0                              # kicad-cli 10 and ngspice; 0.8 GB download
.venv/bin/pio pkg install -d templates/fw                 # pre-downloads the ESP32-C3 toolchain into ~/.platformio
```

Repo-local installs go in `.venv/` and `tools/node/`, both gitignored. The exceptions are PlatformIO's package cache
(`~/.platformio`) and Docker's image store. The last command downloads the toolchain up front, so the first run
doesn't stall on it. Without it, the first firmware build downloads it and takes several minutes; later builds take
about 5 s.

Optional: Espressif QEMU, to boot the built firmware headless. Install steps are in `NOTES.md` ("Firmware emulation").

**Environment detection** (`src/tools/env.ts`). At start, Bringup picks a backend for each tool from what the machine
has, with repo-local tools first: `tools/node/.../tsci`, `.venv/bin/python`, `.venv/bin/pio`, and a local `kicad-cli`
or else the `kicad/kicad:10.0` Docker image. A missing tool turns into an `artifact.failed` event with a clear
message, not a crash.

## Run

```bash
# Fastest look, with nothing but `npm ci`: scripted models, hardware stubbed. About 10 s (5 s on an idle machine).
npm run bringup -- briefs/logger.md --mock --no-hardware

# Skip the brief reviewer gate (the consistency and grounding checks still run)
npm run bringup -- briefs/logger.md --mock --no-review

# No API key needed: scripted models, real tools. About 1–3 min once the tools are installed.
npm run bringup -- briefs/logger.md --mock

# Real models: copy .env.example to .env and set one of
#   OPENAI_API_KEY=...
#   ANTHROPIC_API_KEY=... and ANTHROPIC_BASE_URL=...   (the event's Claude credit, build.jigjoy.ai/credits)
npm run bringup -- briefs/logger.md
```

**Change one thing yourself.**

```bash
# The demo: the dashboard opens, the first design settles, then "make it 60 mm wide" goes in and ripples.
# The run stays up afterwards: type your own change in the dashboard ("make it 40 mm wide"). Stop ends it.
npm run demo

# With nothing but `npm ci` (hardware stubbed): the same settle → change → ripple → consistent story, in about 10 s.
npm run demo -- --no-hardware

# The same from the CLI: each --change is sent after the design settles, and the run ends once the last one re-settles.
npm run bringup -- briefs/logger.md --mock --change "make the board 40 mm wide"

# Dashboard for any run, live or finished (http://localhost:4317; if that port is taken it picks a free one and
# prints the URL, or pass a port: `npx tsx src/dashboard/cli.ts out/quick 4400`)
npx tsx src/dashboard/cli.ts
```

Each change gets a row in `ripples.json` and in the report's "Change requests" table: the contract fields it touched,
the agents that reworked something, the ones that only checked it, the ones that stayed idle, and the time until the
design was consistent again. The scripted agents understand "N mm wide" and "blink faster when tilted". Use real
models for anything else.

`--no-hardware` swaps the three builders for stubs (`src/tools/stubs.ts`). Each stub derives its artifact straight
from the contract: board nets from the pin map, enclosure cutouts from the connectors, firmware pins from the pin
map. The agents, change control, the grounding check and the consistency checks all run as usual, and the report
says the hardware was stubbed. Without `--no-hardware`, a missing tool is a warning: its build fails with
`artifact.failed`, and the run ends unsettled. The report then opens with a "Missing tools" section listing what to
install.

Each run writes everything under `out/<runId>/`. `<runId>` is a UTC timestamp such as `20261031-142530`, or you can
choose the folder with `--out <dir>`. The last line of the run prints the report's path.

| Path | Contents |
|---|---|
| `report.md` | Start here: settled or not, violations, the brief review verdict and findings, changes proposed, held, approved and rejected, tool table |
| `contract.json` | The final design contract |
| `brief.md` | The brief the run started from |
| `board/rev-N/` | One folder per build: `board.circuit.tsx`, KiCad project (`dist/board/kicad/board.kicad_pcb`), `board.step`, `board.png`, `fab/`. The latest render is also at `board/board.png` |
| `fab/` | The latest board's fab package in JLCPCB's assembly format (PCBWay takes it too): `gerbers.zip` (9 layers + Excellon drill), `bom.csv`, `cpl.csv`, and `README.txt` with a checklist of what to verify before ordering. Skipped under `--no-hardware` |
| `enclosure/rev-N/` | `case.step`, `case.stl`, `cutouts.json` |
| `firmware/rev-N/` | PlatformIO project with the generated `include/pins.h` |
| `trace.jsonl` | Every event in delivery order |

Exit codes: 0 when settled with no violations, 2 when unsettled (including when a hardware tool is missing), and 1 on
bad arguments.

Dashboard: `npx tsx src/dashboard/cli.ts out/<runId>`.

**Design tournament.** Run several variants of one brief at the same time, each in its own process, then rank them:

```bash
npm run tournament -- briefs/logger.md --variants briefs/variants-logger.json --mock
```

A variant is a short constraint appended to the brief, for example "Board must be at most 40 mm wide". Results go to
`out/tournament-<ts>/<variant>/`, one full run each, plus `scoreboard.json` and `scoreboard.md`. The ranking puts
settled designs first, then fewest violations, then BOM cost (live JLCPCB prices), then board area. It needs the full
toolchain. With the four example variants and `--mock`, all four settle with 0 violations in about 80 s of wall time
for the four concurrent runs. The 40 mm board ranks first on board area. The BOMs tie, because the scripted models
pick the same parts for every variant.

## Tests

```bash
npm test             # node:test via tsx; unit and integration tests
npm run typecheck
```

Integration tests (`*.int.test.ts`) run the real tools (tscircuit + KiCad, build123d, PlatformIO, ngspice, QEMU)
against a reference ESP32-C3 + SHT40 logger (`test/fixture.ts`). Each one **skips** when its tool is missing, so
`npm test` passes on a bare checkout:

| Checkout | Result | Time |
|---|---|---|
| After `npm ci` only | all pass; the tool-dependent integration tests skip | about 20 s |
| Full toolchain | all pass; only the 3 QEMU tests skip (QEMU is optional) | about 2 min; 3 min 15 s with QEMU |

## Prior art and what's new

The pieces are not new on their own. We credit:

- **[Odem](https://www.producthunt.com/posts/1263017)**: "Cursor for hardware", parts to PCB to enclosure to firmware.
- **[MeshCue Forge](https://github.com/meshcue/meshcue-forge)**: one spec as the source of truth, with a cross-domain DRC
  for pin conflicts, power budget and enclosure cutouts.
- **[Copperhead](https://github.com/copperheadhq/copperhead)**: a gated KiCad agent where doc drift fails the build.
- **[DRCY](https://arxiv.org/abs/2603.15672)**: multi-agent datasheet review of schematics.
- **[Engineering Studio AI](https://lablab.ai/ai-hackathons/nativebuilder-build-without-limits/x-dark-x/engineering-studio-ai-multi-agent-design-system)**:
  parallel agents with disagreement reconciliation.
- **[tscircuit](https://tscircuit.com)** (circuits as code, autorouting) and **[KiCad](https://www.kicad.org)** (DRC,
  ERC, exports), which do the real EDA work.

What Bringup adds: the consistency checks run **live, mid-run, as events** that wake only the affected agents, instead
of as a final pipeline stage. Contract fields have **owners and versions**, and cross-owner edits go through
**change control built on Mozaik interception**, the way engineering change orders work.

## Limits

- **Review before ordering.** The logger is electrically complete: Li-ion charger and battery connector, USB-C CC
  pull-downs, D± to the ESP32-C3's native USB, I2C pull-ups and bypass caps. Each run exports a fab package. It is
  still not fab-ready without a human pass:
  - the ESP32-C3-MINI-1 land pattern has approximate pad offsets, and only one of its GND pads is wired
  - there is no ground pour
  - the SHT40 and the button use stand-in footprints
  - the TP4054 pin order comes from the pin-compatible LTC4054
  - JST-PH battery polarity varies between packs

  `fab/README.txt` lists every item to check; `catalog/README.md` has the details.
- **Small boards only.** Placement and routing are proven on 45–70 × 30 mm boards with up to about 20 parts.
- **QEMU is optional.** It is not installed by default; without it the report says "not run" and the QEMU tests
  skip. Installed, every run boots its newest firmware to `bringup rev N` (event `firmware.booted`). There is no SHT40
  in emulation, so the firmware then prints `SENSOR FAIL`. Wokwi could simulate the sensor but needs a token.
- **Stock is live, the catalog is small.** The part selector checks live JLCPCB stock and price by LCSC number, but it
  can only choose from the vetted catalog (one MCU family today).

## Use from Claude Code

Bringup is also an MCP server (stdio), so a coding agent can start runs and read their results. Register it from
the repo root:

```bash
claude mcp add bringup -- "$PWD/node_modules/.bin/tsx" "$PWD/src/mcp/cli.ts"
```

Tools: `start_design {brief, mock?}` starts a run in the background and returns its `runId` at once (`mock` defaults to
true: scripted models, no API key). `design_status`, `read_contract`, `get_report` and `list_events {sinceSeq?}` read
`out/<runId>/`. Cursor and other MCP clients take the same command. Set `BRINGUP_OUT` to keep runs somewhere other than
`out/`.
