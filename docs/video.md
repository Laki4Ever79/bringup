# Demo video (about 3:00, screen recording)

**The one line, said at the start and the end:** "Change one thing, and the whole hardware design follows: board, case,
firmware and parts, in parallel, and still consistent."

Everything that doesn't serve that line stays out of the video: the tournament, MCP, fab package, reviewer replays.

## Sources: record these before editing

| Source | Command | Use for |
|---|---|---|
| **Scripted live run** | `npm run demo` (logger brief, scripted agents, real tools, dashboard). The first design settles, then "make it 60 mm wide" goes in 8 s later. The run stays up, so type "make it 40 mm wide" yourself | Acts 2 and 3 |
| **The proof** | The hub page's proof strip, from `docs/experiment.md` (`npm run experiment`, about 30 min) | Act 4 |
| **The real board** | `npm start -- briefs/logger.md --mock --no-review --bench real --change "blink faster when tilted"` with the ESP32-S3 on USB | Act 5 |

**Say "scripted agents" once** over Act 2. Real-model runs haven't taken a mid-run change yet (README status). If one
does before recording, use it and say "real models" instead.

Before recording:
- 1920×1080, notifications off, `.env` never on screen.
- QEMU installed (the tool table shows a `QEMU:` path).
- Board flashed and on USB for Act 5.

**Never cut in a way that changes what happened.** Cutting waiting time is fine. Say "sped up" if you speed it up.

## Act 1: the problem (0:00–0:20)

| On screen | Voice-over |
|---|---|
| The hub page: "Change one thing. The whole design follows." | "Move a connector five millimetres and three teams have work to do: the board, the case, the firmware. Hardware bugs live in that gap." |
| The one line. | "Bringup: change one thing, and the whole design follows, in parallel, and still consistent." |

## Act 2: the first design (0:20–0:50)

| On screen | Voice-over |
|---|---|
| Start the logger brief. The agent tiles light up together; the board, case and firmware build. | "One brief in. Nine participants, each its own Mozaik loop, all running at once, all working against one shared design contract." |
| "Consistent at rev 7 · Now change one thing ↑". PCB with rulers; 3D case. | "A routed board, a printable case and firmware that compiles against the real pin map. Now the interesting part." |

## Act 3: change one thing (0:50–1:50)

| On screen | Voice-over |
|---|---|
| Type "make it 40 mm wide", or let the demo's "60 mm wide" go in. **01** shows the request; **02** inks `outline v1 → v2`. | "One change. It touches one field of the contract: the outline." |
| **03**: architect, board and case go dark and work; parts, firmware build and grounding stay dimmed; firmware shows "checked, no change". | "Mozaik situations are the dependency graph. Only the agents the outline affects wake up, and they rework at the same time. The rest stay idle." |
| **04**: contract checks go red (2 violations), then green. | "Plain code compares what was actually built (board, case, firmware) against the contract until they agree." |
| The result line: "CONSISTENT AGAIN IN … · 4 of 9 agents woke". **05 What moved** with rulers: 50 → 40 mm. | "Consistent again, without anyone coordinating by hand." |
| Open Change control: a held change, approved by its owner. | "And no agent changes a field it doesn't own. Mozaik interception holds that call until the owner approves." |

## Act 4: the proof (1:50–2:20)

| On screen | Voice-over |
|---|---|
| The hub's proof strip: 5 changes; 0 violations against 14 mismatches. | "Does the shared contract matter? We applied five changes twice. With it: zero violations. With every team on its own copy: fourteen mismatches would ship." |
| Zoom in on one row: "cutout for J1 is left@15 mm, connector is bottom@25 mm". | "Like a USB port that no longer meets its hole in the case." |

## Act 5: the real board (2:20–2:50)

| On screen / presenter | Voice-over |
|---|---|
| The ESP32-S3 on the desk, LED blinking at 1 Hz. Tilt it: nothing changes. | "And it reaches real hardware." |
| Type "blink faster when tilted". The firmware tile wakes; the flash bar runs to rev N+1. | "One more change, in plain words. The firmware agent turns it into a setting, the firmware rebuilds, and the board is reflashed." |
| "TILT THE BOARD" on the stage; tilt it. The LED blinks fast. The check reads "tilted 250 ms (measured from N LED toggles)". | "Measured on the board itself, not assumed." |

Say it plainly: the board on the desk is an **ESP32-S3 dev board standing in for the design's C3**.

## Close (2:50–3:00)

| On screen | Voice-over |
|---|---|
| End card: the one line plus `github.com/Laki4Ever79/bringup`. | "Change one thing. The whole design follows. That's Bringup." |

## Edit notes

- Keep at least one frame with **two or more agent tiles working together**. That's the concurrency the judges score.
- Keep the result line on screen for at least 3 s.
- Export 1080p, 30 fps, under 3:00.
