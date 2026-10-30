# Demo video: shot list (2:30, screen recording)

What we record: `npm run demo -- --real` with the redesigned dashboard (`docs/design/dashboard.md`). The demo runs the
logger brief with real models, opens the dashboard, and after 20 s sends the engineer's change request "make the board
60 mm wide". Our real runs took about 190 s to settle (`out/real-2`: 187 s, `out/real-4`: 192 s), so **record the whole
run once and cut it down**. Don't speed up the agent activity itself, only the waiting between events.

## Before recording

- Window at 1920×1080, browser fullscreen, dashboard zoom 100 %. Dark desktop, notifications off.
- `npm test` green, and `npm run bringup -- briefs/logger.md --mock` settles. This proves the tools are warm, so the
  first PlatformIO build doesn't stall on a toolchain download.
- QEMU installed (NOTES.md, "Firmware emulation"), so the report shows the boot line. Check it: the tool table printed
  at start must show a `QEMU:` path, not "missing".
- `.env` holds the API key; never show the terminal while `.env` is open.
- Start the recorder, then run `npm run demo -- --real`. Keep the terminal visible for the first shot only.
- Keep the printed Mozaik Cloud link; it's the last shot.

## Shots

| Time | On screen | Voice-over |
|---|---|---|
| 0:00–0:12 | `briefs/logger.md` in an editor: one page, no pin numbers. | "Small boards fail at bring-up for boring reasons: the firmware drives the wrong pin, the USB port misses the hole in the case. This is a one-page brief, written like a product person would." |
| 0:12–0:20 | Terminal: `npm run demo -- --real`, the dashboard URL and the Mozaik Cloud link appear. Cut to the dashboard. | "One command. Real models, real tools." |
| 0:20–0:45 | **Top bar** shows `LIVE · rev N ▲` climbing. **Agents row**: Architect, Parts, Firmware, Reviewer, Board, Case, Build and Grounding cards, several status rings pulsing **at the same time**. **Revision scrubber**: dots appearing, coloured by agent. | "Every agent is its own Mozaik loop, running concurrently. They share one design contract in Mozaik's runtime state. Every field has an owner and a version. Nobody orchestrates them: each agent subscribes to the fields it depends on." |
| 0:45–1:10 | **Stage, PCB view**: the board appears, then the "what just changed" glow on new parts and nets after a revision. The **3D panel** shows the case and board. | "A change wakes only what it affects. Pins change: the board and firmware rebuild, and the enclosure keeps working undisturbed. The three builds run in parallel." |
| 1:10–1:35 | **Change control** strip: a pull-request card, `firmware → architect · pins · + STATUS_LED → GPIO10`, held, then **approved ✓** with the reason "GPIO10 is free". | "The firmware agent wants a status LED pin, but pins belong to the architect. Mozaik interception holds that tool call mid-loop until the owner approves. That's engineering change control, built on interception." |
| 1:35–1:55 | Around 0:20 into the real run: the engineer's request "make the board 60 mm wide" appears. The stage dimensions change to 60.0 × 30.0 mm; the **Consistency pill** goes amber with a count, then back to green ✓. | "A human can join mid-run. The engineer asks for a wider board. The consistency checks are plain code: they compare what was actually built against the contract. Violations wake only the agents they affect, until everything agrees again." |
| 1:55–2:10 | **Parts (BOM) panel**: hover `U1 ESP32-C3-MINI-1`; it lights up on the PCB and in 3D at the same time. Show the LCSC numbers, live stock and `total $…`. | "Every part comes from a vetted catalog with live JLCPCB stock. The grounding check rejects any pin that neither the catalog nor KiCad's symbol library backs." |
| 2:10–2:22 | **Top bar**: all three pills green (Consistency, Grounding, Review), `settled`. Cut to `report.md`, and zoom on `Firmware boot (QEMU): booted, printed revision N`, then the `fab/` folder: `gerbers.zip`, `bom.csv`, `cpl.csv`. | "Settled: zero violations, the brief reviewer signs off. Out comes a KiCad board, a printable case, a JLCPCB fab package, and firmware that just booted in an emulator and printed the revision it was built from." |
| 2:22–2:30 | The Mozaik Cloud link opened: the agents' loops side by side. End card: `github.com/Laki4Ever79/bringup`. | "Concurrent agents, one live contract, change control on interception. That's Bringup." |

Use the real run's numbers in the voice-over only if they show on screen. Don't quote numbers from other runs over
this footage.

## If the network or the model API is bad: `--mock` fallback

`npm run demo -- --mock` uses scripted models, the same real tools and the same change request. Verified on 30 Oct
2026 (`out/demo-20261030-133550`):
- the 60 mm request applied at 17 s
- held change: 1, approved
- violations caught: 3
- settled at revision 8 in 52 s, review **pass**

The shot list is the same; only the times shift.
- Mock runs are fast. Pause on each panel for 2–3 s in the edit instead of waiting.
- Say "scripted models" once, in the 0:12 shot: "…with scripted models, so it runs without an API key."
- With `--mock` the brief reviewer is scripted too. Don't claim it reviewed with an LLM.

## Edit notes

- Cut dead time between revisions, but keep at least one moment where **two or more agent rings pulse together**. That
  is the concurrency the judges score (30 points).
- Keep the change-control approval and the mid-run request on screen for at least 3 s each; they are the headline
  features.
- The 2:10 line ("the brief reviewer signs off") only works if the take ends with Review green. A real review can
  fail; `out/review-real-2` did. If it fails, either re-record, or keep the take and say "the reviewer flags what's
  still missing" over the Review popover. Never narrate a pass that isn't on screen.
- Captions: same wording as the voice-over, bottom-centre, `#ededed` on `#0a0a0a` at 80 %, in the system UI font.
- Export 1080p, 30 fps, under 3:00.
