# CLAUDE.md: Bringup (3ALET Hackathon)

## What this is
**Bringup** (working title; the repo folder is still `agent-mesh`) is our 3ALET Hackathon entry, in the **Freestyle**
track. The event is NTP Novi Sad + online, 30–31 Oct 2026, run by JigJoy.

Concurrent Mozaik agents turn a short product brief into a hardware design that is consistent across domains:
- in-stock parts (BOM)
- schematic and routed PCB
- an enclosure whose cutouts match the board
- firmware that compiles against the real pin map
- simulation results
- a consistency report

Every agent works against **one live design contract** held in Mozaik's shared `RuntimeState`. A change in one domain
wakes exactly the agents it affects, through Mozaik situations. **Interception** holds risky changes until the owners
of the affected fields accept them, the way engineering change control works.

**Plan, architecture diagram and scope:** https://claude.ai/artifact/GpFMaa2NAE81hn9BSHajQj. Read it with the Claude
Docs tools. It is the source of truth: keep it updated as plans change.

History: on 30 Oct we pivoted away from a software factory ("Agent Mesh"), because it overlapped with JigJoy's own baro
and mozaik-network. We compared robotics (MuJoCo) and chose hardware. The research is in `RESEARCH-HW.md`,
`RESEARCH-ROBOTICS.md` and `RESEARCH.md`.

## What the judges score (Freestyle, 100 points)
- Useful and original: 30
- How it uses Mozaik (agents in parallel, shared state): 30
- It works and runs from the README: 25
- README clarity: 15

Other rules (https://build.jigjoy.ai/rules):
- Must use `@mozaik-ai/core` with **2 or more concurrent agents**.
- The substance must be built during the event.
- The repo must be **public**, with a README covering what it does, the architecture and how to run it.
- Submissions close **Sat 31 Oct 20:00 CET**. You may resubmit; the last entry counts.

The user's priority is **how well we exploit Mozaik's concurrency**. A demanding multi-tool setup is acceptable, and
even welcome as a moat. Things this laptop can't run, such as GPU simulators, still belong in the pitch.

## Headline features
1. **A live design contract.** Fields have an owner and a lease, and are versioned. Plain code checks every change
   across domains, and each violation becomes an event that wakes the affected agents mid-run.
2. **Interception as change control** on pin and connector changes. The critic loops back any claim that has no
   datasheet behind it.
3. **A tournament of whole designs**, for example ESP32-C3 vs nRF52. Branches run in parallel, share research, and are
   scored live.
4. **Mid-run change requests**, such as "make it 50 mm wide" or "part out of stock".
5. **An environment agent** that picks a backend for each tool on each machine: local or Docker, Wokwi or QEMU, real
   model or mock.

The cross-domain DRC and the datasheet critic are guards, not novelty. Prior art for them: MeshCue Forge, DRCY, Odem.
Credit these in the README.

## Mozaik: pinned to exactly `@mozaik-ai/core` 4.1.0
- **Do not upgrade.** npm `latest` is 4.2.0, which is byte-identical to 4.1.0, but the user wants 4.1.0. The rewrite on
  GitHub master (Agent/Loop/Directive, `src/network`) is not released.
- The API cheat sheet is `NOTES.md`. Key points:
  - `defineRuntime<State>()` returns `initializeRuntime`, `join`, `sendEvent` and `runLoop`. "One runtime" is per
    `defineRuntime()` closure.
  - Situations are a `SituationSpecification` plus a `SituationProcessor`. Every participant sees every event, so filter
    on `producerId`.
  - `runLoop` is fire-and-forget, which is what makes agents concurrent.
  - `InterceptionHandler` can pause, rewrite or reject a `function_call` or `model_message` transition.
- Known 4.1 bugs:
  - #115: `publish` is synchronous and re-entrant, so different agents can see events in different orders. Fix: an
    outbox queue.
  - #114: `runLoop` swallows errors, so a crashed agent looks idle. Fix: emit an `agent.halted` event.
  - #113: an interception that returns `idle` crashes the process. Never return `idle`.
- Mock runner for free, keyless runs: `../mozaik-examples/custom-inference-runner/src/runner.ts`.
- Keys come from `.env` (`OPENAI_API_KEY` is set). Never print or commit `.env`. This machine is paired with Mozaik
  Cloud, so each `runLoop` prints a live link.
- Reference examples are in `../mozaik-examples/`, still on 4.1.0 locally. Don't `git pull` there; upstream moved to
  4.2.0.

## Hardware toolchain (verified on this laptop, 30 Oct)
Keep the project self-contained. Python tools go in the repo's `.venv/` and everything else in `tools/`; both are
gitignored. Never install system-wide (no sudo password anyway).

| Step | Tool | How to run |
|---|---|---|
| Circuit as code, autorouting | tscircuit 0.0.3042 (needs bun) | `PATH=$PWD/tools/node/node_modules/.bin:$PATH tsci build board.circuit.tsx --kicad-project` |
| Checks and exports | kicad-cli 10.0.7 | `docker run --rm -u $(id -u):$(id -g) -e HOME=/tmp -v "$PWD":/w -w /w kicad/kicad:10.0 kicad-cli pcb drc --format json -o drc.json board.kicad_pcb` (also `sch erc`, `pcb export step`, `pcb render`) |
| SPICE | ngspice | inside the same `kicad/kicad:10.0` image |
| Enclosure | build123d 0.13 | `.venv/bin/python case.py` (`import_step` → shell → cutouts at contract coordinates → `export_step`/`export_stl`) |
| Firmware | PlatformIO 6.2 | `.venv/bin/pio run -d <fw dir>` (ESP32-C3 toolchain already downloaded) |
| Autorouting fallback | Freerouting 2.5.0 | `java -jar tools/freerouting-2.5.0.jar -de b.dsn -do b.ses --gui.enabled=false` |
| Renders | Blender 5.2.2, `kicad-cli pcb render` | |
| Firmware simulation | Wokwi CLI (needs a token) or Espressif QEMU | not set up yet |
| Robotics extension | MuJoCo 3.17 in `.venv` | `../spikes/robotics/` |

Pitfalls:
- tscircuit routes 0.15 mm tracks, but KiCad's default minimum is 0.2 mm, so KiCad DRC flags them. Treat tscircuit's
  DRC as the truth and KiCad's as advisory, or set the rule.
- tscircuit releases daily, so pin it.
- Smoke tests live in `../spikes/hw/` and `../spikes/robotics/`. Spikes stay outside the repo.

## Schedule (Belgrade time, CET)
| When | What |
|---|---|
| Fri 30 Oct | Build the contract, the agents and the tool wrappers; first full run with the mock model |
| Sat 13:00 | First full run with real models; then the tournament, change requests, simulation |
| Sat 17:00 | Optional live demos at NTP |
| **Sat 20:00** | **Submissions close** |

## Open items for the user
- Answer the "Shiva" team invite on the dashboard (https://build.jigjoy.ai/dashboard).
- Create the GitHub repo (public by submission). Ask before pushing.
- Get a Wokwi token, or choose QEMU.
- Find a channel to a teammate's agent (see the plan doc).

## Commands
```bash
npm start          # tsx src/main.ts
npm run typecheck  # tsc --noEmit
```

## Contacts
Discord: https://discord.gg/dvxY9J2kWX · Organizer: miodrag.todorovic@jigjoy.ai
