# Bringup

**Change “one thing”, and the whole hardware design follows: board, case, firmware and parts, in parallel.**

**▶ Watch the 3-minute demo: [youtu.be/b0B6R5KyZ64](https://youtu.be/b0B6R5KyZ64)**

![The engineer types "add a temperature/humidity sensor": 7 of 9 agents wake, the checks find mismatches, and board, case and firmware agree again, with the new sensor on the board and a vent in the case](docs/img/hero.gif)

<sub>Recorded run, scripted agents with the real tools (tscircuit + KiCad, build123d, PlatformIO). The waiting is cut: the
ripple took 3 min 15 s.</sub>

A short product brief goes in. Concurrent [Mozaik](https://www.npmjs.com/package/@mozaik-ai/core) agents turn it into
parts with JLCPCB order numbers, a routed PCB, a printable case whose cutouts match the board, and firmware that
compiles against the real pin map. Then the design changes, the way real designs always do, and Bringup keeps every
part of it consistent. Even designing from scratch is just the first change: the beacon's first design took 7 contract
revisions.

Bringup is a demonstrator for one product family: ESP32-C3 boards built from a small, vetted parts catalog.
3ALET Hackathon 2026, Freestyle track. Built on `@mozaik-ai/core` 4.1.0. Full details: [docs/details.md](docs/details.md).

**The fastest way to see it: [bringup-demo.onrender.com](https://bringup-demo.onrender.com/)**, nothing to install. A read-only dashboard of recorded
runs (the first load after idle takes about 30 s), or press **Try it**: a stubbed scripted run you can change once
("add a temperature/humidity sensor"). The recorded runs used the real tools; live runs there are stubbed, because
the real toolchain (KiCad in Docker, the ESP32 compiler, about 9.6 GB and minutes of full CPU per build) doesn't fit a
free web host. [Why, in detail](docs/details.md#why-the-live-demo-is-stubbed).

## What's real, what's scripted

| Part | In the quick look | In the recorded runs (`docs/runs/`) | On the live site | Locally, fully installed |
|---|---|---|---|---|
| Agents | scripted | scripted (most) · real models (`real-*`, `add-sensor-real*`) | scripted | scripted or real models (your key in `.env`) |
| Board, case, firmware builds | stubbed | real tools | real tools (recorded) · stubbed (Try it) | real tools |
| Checks (consistency, grounding) | real | real | real | real |
| Final brief review | scripted | scripted or a real model | scripted | scripted or a real model |
| The ESP32 board | none | bench runs only | none | `--bench real` |

## Quick look (Node 24 only, no API key, about 1 min)

```bash
git clone https://github.com/Laki4Ever79/bringup && cd bringup && npm ci
npm run bringup -- briefs/logger.md --mock --no-hardware --out out/quick
cat out/quick/report.md   # "settled ... Violations: 0", plus the change requests held by interception
```

This quick look stubs the hardware tools, so it builds no board or case. To see what the real tools produce without
installing them, open the recorded run [docs/runs/add-sensor/](docs/runs/add-sensor/): the
[board render](docs/runs/add-sensor/board/rev-10/board.png), the printable [case](docs/runs/add-sensor/enclosure/rev-9/case.stl)
and [lid](docs/runs/add-sensor/enclosure/rev-9/lid.stl) (GitHub shows them in 3D), the
[report](docs/runs/add-sensor/report.md) and the full trace.

**Words used below.** *Contract*: the one shared design every agent reads and writes. *Settled*: every built file
matches the contract and nothing is left to do. *Grounding*: checking every part and pin against the parts catalog and
KiCad's symbol library. *Brief reviewer*: an AI that judges the finished design against the original brief, with none
of the agents' history.

## What it does

### 1. A brief becomes a whole design

![The run view after the first design: nine agent tiles, the contract fields, the timeline, "First design consistent at rev 7", the routed PCB and the 3D case](docs/img/design.png)

Nine participants, each its own Mozaik loop, work at the same time against **one live design contract**: parts with
LCSC numbers, a routed KiCad board, a printable case and lid, and firmware for the real pin map, booted in QEMU.

### 2. Change one thing, and only what it affects wakes up

![After "add a temperature/humidity sensor": board, case and firmware agree in 3 min 15 s, 7 of 9 agents had to act; the new sensor U2 glows NEW on the PCB; the case has a new vent over it](docs/img/add-sensor.png)

"Add a temperature/humidity sensor": the parts agent added the SHT40, the architect wired it, the board re-routed, the
firmware switched on its driver, and **the case cut a vent over the sensor**. 7 of 9 agents woke, 9 mismatches were
caught live, and the design was consistent again in 195 s (`docs/runs/add-sensor/`, scripted agents, real tools).

### 3. Or just edit the files yourself

![The Files panel: the linked git folder, each edit classified (adopted, rebased, re-saved, not in the design), and one commit per settled revision](docs/img/edits.png)

Save an edited `pins.h` or the board in KiCad, and the save becomes a change request: the rest of the design follows. A
linked folder is a git repo with one commit per settled revision; an edit the contract can't hold is flagged, never
silently overwritten (`docs/runs/file-sync/`, `docs/runs/linked/`).

### 4. All the way to a real board, and ready to order

"Blink faster when tilted" changed only the firmware; the real board was reflashed in 16 s and, tilted, blinked at
**244 ms measured** against the 250 ms asked (an ESP32-S3 dev board standing in for the design's ESP32-C3). Every run
hands you case and lid STLs, a JLCPCB fab package and firmware; on a fully green run, **Ready to order** zips exactly
the files JLCPCB asks for and opens the quote page (nothing is uploaded or ordered).

### 5. An on-device model is one more domain that follows

"Add a wake word" asks only for a model. The checks carry it through the rest of the design:

- the parts add a microphone, and the board places it on the maker's land pattern
- the case gets an opening under the sound hole
- the firmware reserves the model's memory, so `pio` counts it
- power moves to USB, because always-on listening breaks the battery target

The model is tied to the sensor path its data was recorded on. A later change such as "make it 40 mm wide" moves the
microphone, and the ml agent marks the data as needing re-recording. Bringup also generates the data-collection
firmware, and checks a TFLite int8 model against the board (`bringup verify-model`). Details:
[docs/edge-ai.md](docs/edge-ai.md).

### 6. So does the production test

"Add a production test fixture" wakes a test agent, which owns the test: which nets get a test pad, and the current
a good board stays under. The board gets pogo pads on its underside, and a test kit is built beside it: a printable
bed-of-nails fixture, factory-test firmware and a test plan with pass limits. "Add a wake word" adds mic pins, and the
test agent gives them pads. "Make it 40 mm wide" moves the pads, and the fixture's holes move with them. Details:
[docs/test-kit.md](docs/test-kit.md).

On an existing KiCad repo, the `adopt` GitHub Action can now comment on a pull request with its change impact: what
the change moved, and which of board, case, firmware and BOM must follow, down to the firmware line
([docs/adopt.md](docs/adopt.md)). And a part out of stock gets options, not an automatic change: other suppliers first,
then a catalog drop-in with what switching would change.

### 7. Ask for the case you want

"Add wall-mount tabs", "engrave "BRINGUP" on the lid", "add a cable gland": a case designer agent owns the case's
walls, height and added features, and the case is rebuilt around the board with them. Each feature is measured on the
built solid. A case change that needs a different board ("make the case 50 mm wide" means a 42 mm board) never
happens silently: you get a warning that the PCB will change, and it goes ahead only if you approve it. Details:
[docs/case-editing.md](docs/case-editing.md).

## Architecture

```mermaid
flowchart LR
  E["Engineer<br/>brief · typed change · saved file"] -->|"change.requested"| C
  subgraph RS["Mozaik RuntimeState"]
    C[("Design contract<br/>fields with an owner and a version")]
  end
  A["architect (LLM)"] <--> C
  P["parts (LLM)"] <--> C
  C -->|"contract.changed<br/>situations decide who wakes"| B["board<br/>tscircuit + KiCad"]
  C --> X["case<br/>build123d"]
  C --> F["firmware<br/>PlatformIO + QEMU"]
  B --> K["consistency + grounding<br/>(plain code)"]
  X --> K
  F --> K
  K -->|"violations wake the owners"| A
  K -->|"design.ready"| R["brief reviewer<br/>(LLM, fresh context)"]
  R -->|"findings to the field owners"| A
  A -.->|"a change to a field it does not own"| I{{"interception:<br/>held for the owner"}}
```

There is no orchestrator: no agent calls or awaits another. How it uses Mozaik:

- **`RuntimeState`** holds one live design contract per run; every field has an owner and a version.
- **Situations are the dependency graph**: each participant's situations decide which changes wake it.
- **`runLoop`** is fire-and-forget, so every agent turn runs concurrently with the others.
- **`InterceptionHandler` is change control**: a change to another owner's field is held mid-loop until the owner decides,
  and owners do say no: in real run 7 interception held 18 changes and the owners rejected 8 ([docs/runs/real-7](docs/runs/real-7/report.md)).
- **Plain-code participants** (builders and checks) and a custom `InferenceRunner` (`--mock` runs with no key).

Events, checks, the full Mozaik table and our 4.1 workarounds (#113, #114, #115) are in [docs/details.md](docs/details.md).

## Install & run

```bash
npm ci              # about 12 s
npm run setup       # the full toolchain, repo-local; installs only what's missing (about 14 min the first time)
npm run doctor      # what each tool will use, and which optional settings are set (never their values)
npm run demo        # the dashboard opens, a design settles, a change ripples; type your own change after it

npm run bringup -- briefs/beacon.md --mock                                    # scripted models, real tools
npm run bringup -- briefs/logger.md --mock --change "make the board 40 mm wide"   # a change from the CLI
npm run bringup -- briefs/logger.md                                           # real models: a key in .env
```

Prerequisites: Linux x86-64, Node 24, [uv](https://docs.astral.sh/uv/), and Docker usable without `sudo`; about 9.6 GB
of disk. `npm run setup` checks them first and says plainly what's missing. Optional settings go in `.env` (copy
`.env.example`). The manual install steps, every command (link, status, simulate, tournament, MCP), the run folder and
the tests are in [docs/details.md](docs/details.md).

## Honest status

- Scripted runs settle with 0 violations and take mid-run changes, with the real board, case and firmware tools.
- Real models take mid-run changes too (run 20: a sensor swap rippled to consistent in 75 s, 40 mm wide in 28 s;
  that run as a whole then failed the final review and did not settle).
- **A real-model run has passed the final brief review.** We used the night's real-model runs to find and fix general problems (the designers now see the same computed facts as the reviewer, and the review's computable checks run live during design). After those fixes, run real-pass ([docs/runs/real-pass](docs/runs/real-pass/)) designed the beacon from its brief with real models and real tools, failed review 1, fixed itself and passed review 2 (settled at rev 19, 0 violations, about 8 minutes). Each real run tonight surfaced a concrete blocker, and each fix removed it for every run after it; that is how this run got through. A few known blockers remain (a lower-dropout regulator for the parts catalog, a longer advertising window, clearer battery assumptions), and each one removed should raise the pass rate further.
- Boards need a human review before ordering (`fab/README.txt` lists every item); the parts catalog is small.

## Credits

Prior art we credit: Odem, MeshCue Forge, Copperhead, DRCY, Engineering Studio AI; tscircuit and KiCad do the real EDA
work. What Bringup adds is change propagation across board, case, firmware and parts (details and links in
[docs/details.md](docs/details.md#prior-art-and-whats-new)).
