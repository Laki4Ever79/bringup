# Demo video (about 3:00, works on mute)

**The one line, at the start and the end:** "Change “one thing”, and the whole hardware design follows: board, case, firmware and parts, in parallel."
(Designing from a brief is the secondary point, in the body text, not in the line.)

Storyboard approved by the user on 31 Oct. Built in Motion Canvas (`video/`), on top of real screen recordings.

## Rules

- **Works on mute.** The big burned-in caption on each beat carries the story; the voice-over is extra (the room's
  speakers may not be heard). On stage, the presenter can talk over the muted video.
- **Motion Canvas adds only captions, callouts and cards.** A card is either a labelled illustration (beat 1) or real
  numbers from a run file (beats 7 and 8). We never animate a run that didn't happen.
- **Never cut in a way that changes what happened.** Cutting waiting time is fine. If a clip is sped up, it says so on
  screen.
- Say "scripted agents · real tools" on the footage from the scripted run, and "real models" only on beat 7.
- The board on the desk is an **ESP32-S3 dev board standing in for the design's C3**; say so on screen.
- At least one frame with several agent tiles working together; the result line on screen for 3 s or more.
- Export 1920×1080, 30 fps, under 3:00.

## Sources

| Source | Where | Shows |
|---|---|---|
| Footage, Acts 1–4 (scripted agents, real tools) | `../wt-board/out/footage/act-{1..4}.webm` (31 Oct re-recording, legible tiles), shot list in `shots.md` there; cut by `video/cut-footage.sh` | hub, first design, the 40 mm ripple, the evidence band |
| real-20 (real models) | `docs/runs/real-20/ripples.json`, `report.md` | sensor swap: 2 mismatches caught and cleared, 75 s, case idle |
| A/B experiment | `docs/experiment.md` | 0 violations against 16 mismatches |
| The real board | phone video, still to record | "blink faster when tilted" → reflash → tilted 244 ms measured vs 250 ms |

## Beats

| # | Time | Source | Burned-in caption | Voice-over |
|---|---|---|---|---|
| 1 | 0:00–0:15 | Animation, labelled "illustration": a USB-C port slides 5 mm and misses its hole in the case | "Move a connector 5 mm. Three teams have work to do." | "Move a connector five millimetres, and the board, the case and the firmware all have to change. Hardware bugs live in that gap." |
| 2 | 0:15–0:22 | Title card | "Bringup" + the one line | Reads the one line. |
| 3 | 0:22–0:50 | `act-2.webm` 0:00–0:20 (tiles light up together), 1:49 (settled); a card listing the real outputs: `case.stl`, `lid.stl`, `fab/gerbers.zip`, `bom.csv`, "firmware booted in QEMU", "SPICE power check" | "One brief in. 9 agents at once, one shared design contract." Small: "scripted agents · real tools" | "Each agent is its own Mozaik loop, all running at once against one design contract. Out come a routed board, a printable case and firmware for the real pin map." |
| 4 | 0:50–1:05 | `act-3.webm` 0:17–0:21: typing "make it 40 mm wide"; callout on `outline v1 → v2` | "Change one thing." | "One change. It touches one field of the contract: the outline." |
| 5 | 1:05–1:30 | `act-3.webm` 0:21 on: 4 tiles working, the rest dimmed; checks red, then green (waiting cut) | "Only the affected agents wake, and they work at the same time." | "Mozaik situations are the dependency graph: only the agents the outline affects wake up, and they rework in parallel. Plain code checks what was actually built until it agrees." |
| 6 | 1:30–1:45 | `act-3.webm` 1:29 (result line, held 3 s+), 1:50 (what moved 50 → 40 mm), 1:57 (What changed & why) | "Consistent again. Nobody coordinated by hand." | "Consistent again, without anyone coordinating by hand. And no agent can change a field it doesn't own: Mozaik interception holds that until the owner approves." |
| 7 | 1:45–2:10 | Card from real-20's `ripples.json` over its report | "With real models, too." Card: "Our sensor is out of stock" · ✗ firmware built for the old sensor · ✗ board still places the old part · ✓ consistent again in 75 s · case stayed idle | "With real models: the sensor goes out of stock, the system catches two mismatches it caused, and clears them in 75 seconds. The case never woke, because nothing physical changed." |
| 8 | 2:10–2:35 | Card: 0 vs 16 counting up; then `act-4.webm` 0:04 closing in on "cutout for J1 is left@15 mm, connector is bottom@25 mm" | "6 changes, applied twice: 0 violations vs 16 mismatches shipped." | "Does the shared contract matter? We applied six changes twice. With it: zero violations. With every team on its own copy: sixteen mismatches would ship. Like a USB port that no longer meets its hole." |
| 9 | 2:35–2:55 | Phone video of the board: slow blink; picture-in-picture of typing the change and the flash bar; tilt; fast blink; the measured number | "And it reaches the real board." Small: "ESP32-S3 dev board, standing in for the design's C3" | "One more change, in plain words. The firmware rebuilds, the board is reflashed, and it's measured on the board itself." |
| 10 | 2:55–3:00 | End card | "Change one thing. The whole design follows." + `github.com/Laki4Ever79/bringup` · built on Mozaik | "That's Bringup." |

**About the footage run.** Its automatic change is "blink faster when tilted" (firmware only); we skip it in the video.
"Make it 40 mm wide" is then typed from 50 mm, so the run view's proof line matches the experiment's "10 mm narrower"
trial. The ripple plays in real time with no cuts (act-3 0:21–0:58): typed → "Consistent again in 31 s · 4 of 9 agents
woke". At about 0:30 the Consistency tile shows FAILED with 5 violations for a few seconds before the builders catch
up; that's real, it's "the checks go red, then green", and the caption says so. The pointer is a drawn SVG cursor that
follows the recording's real mouse moves (headless video has none); act 4's zoom is a CSS scale on the page.

**Voice.** Soniox TTS (`video/tools/voice.py`, run with the livekit project's venv), one WAV per beat, laid on the
timeline from `video/src/timing.json` by `video/tools/mux.sh`. The captions carry the story without it.

## Live presentation at NTP (15 min slot: about 5 min talk, the rest Q&A)

| Time | Beat | How |
|---|---|---|
| 0:00–0:40 | The problem + the one line | 1 slide; start the scripted run while talking |
| 0:40–2:20 | A judge types "make it 40 mm wide"; narrate the ripple and the Mozaik point | live dashboard, scripted mode, said aloud |
| 2:20–3:00 | 0 vs 16; real models (run 20): sensor swap 75 s, 40 mm 28 s | 1 slide |
| 3:00–4:20 | The board in a judge's hand: "blink faster when tilted", reflash, tilt, 244 ms | live; beat 9's clip as the fallback |
| 4:20–5:00 | Honest limit (no real run has passed the final review) + close | 1 slide |

Ready for Q&A: the "What changed & why" drawer, real-20's trace, the BLE phone read, parallel vs taking turns
(31–72 s vs 36–94 s), the reviewer's catches.
