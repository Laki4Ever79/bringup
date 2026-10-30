# Demo video: three acts (about 3:00, screen recording)

**The one line, said at the start and the end:** "A team of agents designs hardware around one shared contract, and
every change is checked by someone other than the agent who made it."

Everything else in the repo (tournament, MCP, fab package, `--no-hardware`) stays out of the video. See "Also in the
repo" in `docs/submission.md`.

## Sources: record these before editing

| Source | Command | Use for |
|---|---|---|
| **Live run** | `npm run demo -- --real` (logger brief, real models, dashboard, the engineer's "make the board 60 mm wide" after 20 s) | Act 2: concurrency, the held change, the 60 mm ripple |
| **Replay of real run 8** | `npx tsx src/dashboard/cli.ts ../agent-mesh/out/real-8`, then scrub revisions | Act 2: the reviewer blocks and the team fixes. Fallback Act 3: the 0 µA sleep claim |
| **Replay of real run 7** | `npx tsx src/dashboard/cli.ts ../agent-mesh/out/real-7` | Fallback Act 3: the 60-day target |
| **The bench** | see `docs/design/bench.md` (not written yet) | Act 3, only if the bench works on the day |

Real runs now take 8 to 16 minutes, because the reviewer gets up to 3 rounds (real-6: 487 s, real-7: 812 s,
real-8: 967 s). Record the live run once and cut the waiting. **Never cut in a way that changes what happened.** In a
replay, say "in an earlier run" over it.

Before recording:
- 1920×1080, dark desktop, notifications off.
- QEMU installed (the tool table shows a `QEMU:` path).
- `.env` closed, and never on screen.

## Act 1: the problem (0:00–0:20)

| On screen | Voice-over |
|---|---|
| `briefs/logger.md` in an editor: one page, no pin numbers. A slow scroll. | "Hardware bugs live in the seams. The schematic is right, the case is right, the firmware is right, and the board still doesn't work, because they drifted apart." |
| Title card with the one line. | "Bringup: a team of agents designs hardware around one shared contract, and every change is checked by someone other than the agent who made it." |

## Act 2: the team (0:20–1:50), the four checkers in action

| Time | On screen (dashboard, `docs/design/dashboard.md`) | Voice-over |
|---|---|---|
| 0:20–0:40 | Live run. **Agents row**: architect, parts and firmware reviewer rings pulse **at the same time**; the board, case and build cards spin up. **Revision scrubber** dots appear, coloured by agent. | "One brief in. Every agent is its own Mozaik loop, running concurrently, and they share one design contract. Each field has one owner." |
| 0:40–1:00 | **Change-control card**: firmware → architect · pins · held ⏸, then **approved ✓** with the owner's reason. | "Checker one is the owner. The firmware agent wants a pin it doesn't own. Mozaik interception holds that call mid-loop until the architect, who owns the pins, approves it." |
| 1:00–1:20 | Live run, about 20 s in: the engineer's request "make the board 60 mm wide". The stage reads 60.0 × 30.0 mm; only the board and case cards rebuild. The **Consistency pill** goes amber with a count, then green. | "A human can join too. The engineer asks for a wider board. Only the board and the case wake up. Checker two is plain code: it compares the board, case and firmware that were actually built against the contract, until they agree." |
| 1:20–1:50 | **Replay of real-8.** The Review pill is red. Open the popover: "no CC resistors or equivalent sink controller are included". Scrub to the architect's held change "Add required USB-C sink CC pull-down resistors", approved by the parts agent. In the BOM, R2 and R3 (5.1 kΩ) appear; scrub on to the next review, where that finding is gone. | "Checker three is a reviewer with a fresh context and only the brief. In an earlier real run, it failed the design: the USB-C port had no CC resistors, so a charger wouldn't supply power. The agents added them, through the same change control, and the next review dropped it." |

## Act 3: bring-up (1:50–2:50). PLACEHOLDER: as designed in `docs/design/bench.md` §6, not yet run

> **Only use this act if the bench works on the day.** The beats below follow the bench design (§6); nothing is plugged
> in yet. Before recording, replace each line with what the bench actually did. Keep these caveats:
> - **Say the stand-in out loud.** The board on the desk is an **ESP32-S3 dev board standing in for the C3 design**,
>   and the MPU-6050 die temperature stands in for the SHT40. The dashboard badges it.
> - **Show the REPLAY badge** if the run falls back to a recorded session, and say "recorded" over it.
> - **Name the measured average for what it is:** charge per wake above the dev board's floor, rescaled to the
>   contract's period, plus the design's sleep current (`measuredAverageMa`, never below the MCU's 5 µA deep-sleep
>   floor). It is not the dev board's raw current.

| Time | Presenter / on screen | Voice-over (draft) |
|---|---|---|
| 1:50 | Tilts the board; the dashboard's 3D board tilts in sync; LED at 1 Hz on camera. | "Checker four is the real board. This one on my desk runs the firmware the agents just wrote." |
| 1:58 | Types "blink faster when tilted" in the change bar. The firmware lane wakes; PR card `behavior +tiltBlinkMs 100` → approved. | "A change request, in plain words. The firmware agent turns it into a setting, and the owner approves it, like every other change." |
| 2:10 | Flash bar: build → write 37…100 % → boot rev N ✓. | "Built, flashed, and booted, with the board reporting the revision it's running." |
| 2:22 | Tilts the board: LED blinks fast; tilt trace crosses 20°; Bench pill ✓ rev N. | — |
| 2:28 | "Does it really last six months?" The fixture switches to duty mode; current spikes every 3 s over the dashed floor. | "Now the question the agents could only estimate." |
| 2:43 | `bench.measured`: measured vs estimated bars on the battery gauge; PR card `rails 3V3 averageMa (measured)` → approved; the budget line reads "(measured on bench, rev N)"; the reviewer re-judges battery life. | "The bench writes the measured current back into the contract, through the same change control. The reviewer judges battery life from a measurement, not a guess." |

## Fallback Act 3 (1:50–2:50): the reviewer catches the agents gaming the numbers

Use this if the bench isn't ready. All three beats come from real runs, so show them as replays and say so.

| Time | On screen | Voice-over |
|---|---|---|
| 1:50–2:10 | **Replay of real-7.** Scrub to the `requirements` change that sets `batteryLifeDays: 60`. Open the review popover: "The contract states batteryLifeDays = 60, but the brief requires at least 6 months." | "Agents under pressure take shortcuts. In run 7, the architect couldn't reach six months of battery, so it quietly changed the target to sixty days. The reviewer had only the brief, and blocked it." |
| 2:10–2:30 | **Replay of real-8.** Battery gauge: "Estimated 204 days vs 180 target". The review popover: "assumes 0 µA sleep … which is impossible". | "In run 8 the team hit the target on paper, 204 days, by assuming the chip draws zero current asleep. Blocked again." |
| 2:30–2:45 | `report.md` of real-6, with the reviewer's arithmetic next to commit `e904421` ("battery current sums every battery-fed rail"). | "Once, the reviewer even caught a bug in our own calculator. We fixed the code." |
| 2:45–2:50 | — | "No real run has passed the final review yet, and the report says so." |

## Close (2:50–3:00)

| On screen | Voice-over |
|---|---|
| Mozaik Cloud: the agents' loops side by side. End card: the one line plus `github.com/Laki4Ever79/bringup`. | "Concurrent agents, one contract, and nobody checks their own work. That's Bringup." |

## Fallback if the network or model API is bad

Use `npm run demo -- --mock` for Act 2's live part. Verified on 30 Oct (`out/demo-20261030-133550`): the 60 mm
request applied at 17 s, 1 held change approved, and the run settled in 52 s.
- Say "with scripted models" once.
- The reviewer is scripted in mock runs, so take the reviewer beats from the real-7 and real-8 replays, as above.

## Edit notes

- Keep at least one frame with **two or more agent rings pulsing together**. That's the concurrency the judges score.
- Keep each checker on screen for at least 3 s: the held change, the Consistency pill, the Review popover.
- Captions match the voice-over: bottom-centre, `#ededed` on `#0a0a0a` at 80 %.
- Export 1080p, 30 fps, under 3:00.
