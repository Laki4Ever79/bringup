---
name: bringup
description: Use when asked to design a hardware device (board, case, firmware, parts) with Bringup, change a Bringup design, read a run's results, check a board build, or add an MCU to Bringup. Covers the CLI, the MCP server, the run folder and the dashboard.
---

# Using Bringup

Bringup turns a short product brief into a consistent hardware design: parts, routed PCB, enclosure, firmware,
simulation and a consistency report. Concurrent agents share one design contract; a change wakes only the agents it
affects. Full reference: `README.md`, `docs/details.md`.

## Before anything: is the machine ready?

```bash
npm run doctor     # which backend each tool uses; what's missing and the setup flag that installs it
npm run setup      # repo-local toolchain, installs only what's missing (add --renode --vendors for STM32/nRF/RP2040)
```

A missing tool doesn't stop a run: its build fails and the report opens with "Missing tools". Read doctor first.

## Run a design

Write the brief as a short Markdown file (see `briefs/*.md`): what the device does, power, size, sensors, radio.

```bash
npm run bringup -- briefs/logger.md --mock --no-hardware --out out/quick   # 10–20 s, nothing but npm ci
npm run bringup -- briefs/logger.md --mock                                 # scripted models, real tools, 1–3 min
npm run bringup -- briefs/logger.md --mock --change "make the board 40 mm wide"   # a change after it settles
npm run bringup -- briefs/logger.md                                        # real models: needs a key in .env
npm run bringup -- system briefs/systems/logger-beacon-uart.json           # several boards and their links
```

- `--mock` costs nothing. A run without it calls real models and spends the user's credit: ask before starting one.
- Exit 0 settled with no violations, 2 unsettled (including a missing tool), 1 error.
- `--stay` keeps a run up after it settles, for changes from the dashboard.

## From Claude Code, through the MCP server

```bash
claude mcp add bringup -- "$PWD/node_modules/.bin/tsx" "$PWD/src/mcp/cli.ts"
```

`start_design {brief, mock?}` returns a `runId` at once (`mock` defaults to true). Then poll `design_status {runId}`;
read `read_contract`, `get_report`, `list_events {sinceSeq?}`; send `request_change {runId, text}` to a running design,
in the engineer's words ("make it 60 mm wide", "the SHT40 is out of stock").

## Read the results

Everything is under `out/<runId>/`. Start with `report.md` (settled or not, violations, review findings, changes
proposed, held, approved and rejected, tools). Then:

| Path | What |
|---|---|
| `contract.json` | the final design contract (parts, pins, outline, connectors, rails) |
| `board/rev-N/` | `board.circuit.tsx`, the KiCad project, `board.step`, `board.png` |
| `fab/` | gerbers, BOM and placement in JLCPCB's format, with a checklist in `README.txt` |
| `enclosure/rev-N/` | `case.step`, `case.stl`, `cutouts.json` |
| `firmware/rev-N/` | the PlatformIO project; `include/pins.h` is generated from the contract |
| `trace.jsonl` | every event in order |

`npm run dashboard` shows any run, live or finished (http://localhost:4317). `npm run bringup -- status out/<run>`
lists files edited by hand in a run folder.

When reporting a run to the user, say whether it settled, the violations left, and what was stubbed or skipped;
don't call a stubbed (`--no-hardware`) board routed.

## Check one board without a run

```bash
npm run board -- out/<run>/contract.json 40x25 [--no-debug-port] [--keep]
```

One real board build at that size: the verdict, the first real error (tscircuit's noise filtered out), DRC errors
by type and the consistency checks. Use a contract from a run; a hand-written one needs every part's pins.

## Choosing or adding an MCU

Bringup designs around any chip it has a profile for (`catalog/mcu/*.json`): ESP32-C3, STM32G031/L031/F103 build
whole boards; others are partial (table in `docs/mcu.md`). The parts agent compares chips on equal terms
(`compare_mcus`), so don't name a default chip in a brief unless the user wants that one. To add a chip, follow
"Adding a vendor" in `docs/mcu.md`; STM32 profiles are generated from ST's pin data (`scripts/mcu/import-stm32.ts`).
