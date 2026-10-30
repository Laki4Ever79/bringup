# Bringup

**Concurrent Mozaik agents turn a short product brief into a hardware design that agrees with itself across domains:** in-stock
parts, a routed PCB, an enclosure whose cutouts match the board, firmware that compiles against the real pin map, a
power simulation, and a consistency report.

3ALET Hackathon 2026, Freestyle track. Built on `@mozaik-ai/core` 4.1.0.

> Status: the contract, change control, consistency checker and the board, enclosure, firmware and SPICE
> wrappers are built and tested against the real tools. The QEMU wrapper is written but has not booted on real QEMU yet. Pieces still marked **** are not wired yet. This README does not claim
> results that haven't run.

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
| `design.settled` | Every artifact is built against the latest revision with no violations |
| `agent.halted` | An agent loop crashed (Mozaik #114 workaround) |

**Cross-domain checks** (`src/contract/consistency.ts`): `outline-mismatch`, `net-missing`, `pin-mismatch`,
`cutout-missing`, `cutout-misaligned`, `rail-overload`, `firmware-build-failed`. Each check reads the artifacts that
were actually built. For example, the firmware's pins are parsed back out of the `pins.h` it compiled.

## How it uses Mozaik

| Mozaik feature | How Bringup uses it | Where |
|---|---|---|
| `SituationSpecification` + processor | Each participant's situations decide which events wake it, so **the situations are the dependency graph between domains** | `src/change-control.ts` (`when`, `ownerReviewsChanges`) |
| `runLoop` (fire-and-forget) | Every agent turn is its own loop, so agents run concurrently; each turn starts from a fresh context | `src/agents/common.ts` (`startTurn`) |
| `RuntimeState` | `BringupState` holds the contract, artifacts, roles and open approvals: one shared state per run | `src/runtime.ts` |
| `InterceptionHandler` | **Change control**: a `propose_contract_change` call on a field the agent doesn't own is held mid-loop until the owner decides; rejections go back to the model as the tool output | `src/change-control.ts` (`ChangeControl`) |
| `createHuman` | Plain-code participants: the change desk routes decisions to held loops. The consistency checker and the engineer join the same way **** | `src/change-control.ts` (`createChangeDesk`) |
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

Requirements: Linux or macOS, Node 24, Docker, [uv](https://docs.astral.sh/uv/), and optionally Java (for the
Freerouting fallback). Everything installs inside the repo, with no system-wide installs.

```bash
npm ci
uv venv .venv && uv pip install platformio build123d
npm i --prefix tools/node tscircuit bun
docker pull kicad/kicad:10.0          # kicad-cli 10 and ngspice
```

The first PlatformIO build downloads the ESP32-C3 toolchain (a few minutes); later builds take seconds.

Optional: Espressif QEMU, to boot the built firmware headless. Install steps are in `NOTES.md` ("Firmware emulation").

**Environment detection** (`src/tools/env.ts`). At start, Bringup picks a backend for each tool from what the machine
has, with repo-local tools first: `tools/node/.../tsci`, `.venv/bin/python`, `.venv/bin/pio`, and a local `kicad-cli`
or else the `kicad/kicad:10.0` Docker image. A missing tool turns into an `artifact.failed` event with a clear
message, not a crash.

## Run 

The end-to-end CLI (`src/main.ts`) is being wired now. The intended commands:

```bash
# No API key needed: scripted models, real tools
npm run bringup -- briefs/logger.md --mock

# Real models: copy .env.example to .env and set one of
#   OPENAI_API_KEY=...
#   ANTHROPIC_API_KEY=... and ANTHROPIC_BASE_URL=...   (the event's Claude credit, build.jigjoy.ai/credits)
npm run bringup -- briefs/logger.md
```

Each run writes everything under `out/<runId>/`:

| Path | Contents |
|---|---|
| `contract.json` | The final design contract |
| `board/` | tscircuit source, KiCad project, DRC result |
| `enclosure/` | Case STEP and STL |
| `firmware/` | PlatformIO project with the generated `include/pins.h` |
| `report.md` | Settled or not, violations, changes proposed, held, approved and rejected |
| `trace.jsonl` | Every event in delivery order |

Exit codes: 0 when settled with no violations, 2 when unsettled, 1 on an environment error.

Dashboard ****: `npx tsx src/dashboard/cli.ts out/<runId>`.

## Tests

```bash
npm test             # node:test via tsx; unit and integration tests
npm run typecheck
```

Integration tests (`*.int.test.ts`) run the real tools (tscircuit + KiCad, build123d, PlatformIO, ngspice, QEMU)
against a reference ESP32-C3 + SHT40 logger (`test/fixture.ts`). Each one **skips** when its tool is missing, so
`npm test` passes on a bare checkout.

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

- **Generic footprints.** The catalog (`catalog/parts.json`) uses tscircuit footprints that stand in for the real land
  patterns (for example, `qfn32` for the ESP32-C3-MINI-1 module). The boards are not fab-ready.
- **Small boards only.** Routing has been proven only on small boards (50×30 mm, a handful of parts).
- **QEMU is optional.** It is not installed by default, and its integration test skips without it. There is no SHT40
  in emulation, so firmware prints `SENSOR FAIL` there. Wokwi could simulate the sensor but needs a token.
- **Stock not re-checked.** LCSC part numbers were not re-checked against live stock during the event.
- **In progress:** the agents themselves (`src/agents/`), the CLI, the briefs, the dashboard, the design tournament
  and mid-run change requests.

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
