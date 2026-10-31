# Design: one point, "change one thing, everything follows" (Sat 31 Oct)

## The point
**Change one thing, and the whole hardware design follows: board, case, firmware and parts, in parallel, and still
consistent.** Every other feature is in service of this, or is cut from the pitch.

Why, in the user's terms: the project had many good pieces and no single winning point. This one is what Mozaik is for
(situations are the dependency graph, `RuntimeState` is the contract, `runLoop` makes the rework parallel), it's what the
industry names as the unsolved problem (Flux, Sept 2026: "moving a connector 5 mm means the ME changes the enclosure and
the EE changes the PCB"; Siemens Fuse covers only chip and PCB tools), and most of it is already built.

## The demo moment
A judge types a change mid-run ("make it 40 mm wide", "the sensor is out of stock"). On screen: the contract fields it
touched, the agents that woke and rework in parallel (the rest visibly idle), the checks go red then green, and one result
line: "Consistent again in 38 s · 4 of 9 agents woke". The board, 3D case and pin map visibly change.

## Workstreams (owner · deliverable)
| Owner | Deliverable |
|---|---|
| 5b | `src/runner/ripple.ts` → live `<outDir>/ripples.json` (schema below) and a "Change requests" table in report.md; then real run 11 with a mid-run change (the first real-model one) |
| 7a | The run view and hub rebuilt with Anthropic's frontend-design skill around the change moment; reads `/files/ripples.json` |
| af | `npm run experiment`: A/B proof. Arm A, contract + situations: time to consistent, agents woken, 0 violations. Arm B, no shared contract: count the cross-domain mismatches that ship. Optional arm C, sequential builders |
| lead | Merge and test; then README, submission and video rewritten around the one point; plan doc updated |

## `ripples.json` schema (fixed)
```json
{ "requests": [ { "id": "", "text": "", "atMs": 0, "fieldsChanged": [], "woke": [], "stayedIdle": [],
                  "violationsPeak": 0, "consistentAtMs": null, "durationMs": null } ] }
```

## Non-goals
- No new hardware domains, no tournament work, no new bench features before the user says go on hardware.

## Anti-goals (failure even if it works)
- Overclaiming: arm B is a simulated baseline and the scripted mode is scripted; both are labelled as such.
- A UI where the change moment isn't readable from across the room in 10 seconds.
- Breaking the judge path: `npm run bringup -- briefs/logger.md --mock --no-hardware` (about 3 s).

## Act 3
If the user says go on hardware, the real ESP32-S3 runs the changed design's firmware. Otherwise the fallback is
`--bench replay`.
