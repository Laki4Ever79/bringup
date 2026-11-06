# Space rules: compact by default, bigger only for a reason

Agreed with the engineer on 6 Nov 2026. Code: `src/contract/space.ts`. Every designer agent gets the numbers below
in its design facts, recomputed from the current contract each turn.

## The rules

1. **Hard limits are part of the minimum, never traded away.** These are manufacturing and printing minimums,
   keep-outs, connector access, and everything the other checks enforce. Space they need is not slack.
2. **Compact by default.** The board's area may be at most **15%** over the smallest board its parts place on. The
   case body may be at most 15% taller than its contents need.
3. **More than that only for a listed reason,** recorded in the design (`outline.sizeReason`, `case.sizeReason`) as
   `{kind, detail}`. The kinds:

   | Kind | When |
   | --- | --- |
   | `engineer-size` | The brief or the engineer set the size; `detail` says where |
   | `usability` | Room to use it: a reachable button or connector, finger room |
   | `standard-fit` | An existing enclosure, a mounting pattern, a rail |
   | `function` | Heat or noise kept away from a sensor, RF clearance |
   | `assembly-test` | Test pads, hand soldering, rework access |
   | `expansion` | Room kept for a part to be added later |
   | `routing` | A smaller board was built and failed its checks (measured, not guessed) |

   An agent may record a reason. You see it afterwards in the report ("Space: … kept for a reason: …") and in
   "What changed & why".
4. **When rules conflict:** safety and manufacturability, then the engineer's own words, then function, usability,
   compactness, and cost last.

A plain-code check (`space-slack`) holds the design to rules 2 and 3. Slack with no recorded reason wakes the
architect (board) or the case designer (case), who shrinks the board or records a reason. The check judges only a
complete design (outline, parts, connectors, rails, pins). Judged earlier, it shrank the board against a half-written
design several times in a row.

## How the minimum is computed

- **Board:** for each height in 1 mm steps, the narrowest width the board generator places every part on. Generated
  support parts count, and so do the mounting-hole keep-outs, connectors kept at the same relative place along their
  edges, and the generator's 1.5 mm gap between parts. The smallest of those areas is the minimum. A board whose
  courtyards (IPC-7351 nominal, 0.25 mm per side) would cover more than **70%** of it doesn't count as feasible.
  This takes about 0.3 s and is cached.
- **Shrinking keeps the shape.** Among the shapes within the limit, the scripted architect takes the one closest to
  the board's current proportions, so a 50 × 30 board shrinks to 36 × 21, not to a 47 × 16 strip.
- **Case:** its body height must clear the connectors' cutouts under the lid's lip and give each wall hole its wall.
  Its footprint follows the board.

Placement doesn't prove routing. Only a real board build proves the chosen size, and the router can fail at a given
size for reasons that have nothing to do with density. That is what the `routing` reason is for.

## Why these numbers

| Number | Source | Status |
| --- | --- | --- |
| 70% courtyard density ceiling for 2-layer routing | J. Watson (Altium), "Density Feasibility: Putting 10 lbs in a 5 lb bag", I-Connect007, 18 Nov 2020, citing IPC-2221 §3.6.2 (Level A 70%, B 80%, C 90%). PCBWay's glossary: above 75-80%, a board may need more layers | Rule of thumb. The IPC text itself is paywalled; we did not see it |
| 0.25 mm courtyard excess | IPC-7351B nominal level, through secondary sources (they quote 0.10-0.25 mm for small chips) | The larger value, so the minimum errs bigger |
| 15% allowance | No standard gives a percentage over the minimum outline. This is project policy, applied on top of a minimum that already includes the density ceiling and the keep-outs. That keeps final density near 60-70% at worst | Policy |
| Antenna at the board edge, 15 mm clear in front | Espressif, *ESP32-C3 Hardware Design Guidelines*, §1.4.7 | Manufacturer guidance; **our placer doesn't follow it yet** (below) |
| Sensor away from MCU and regulator heat | Sensirion, *SHTxx/STSxx Design Guide* v1.1 (2019): "sufficient distance", slits; **no mm figure** | Why `function` is a reason, not a number |

## Measured (6 Nov 2026, the logger, real tscircuit + KiCad builds, JLCPCB 2-layer rules)

| Board | Courtyard density | KiCad DRC |
| --- | --- | --- |
| 50 × 30 mm (the brief's size) | 29% | 0 errors |
| 38 × 30, 35 × 30, 32 × 30 | 38-46% | 0 errors |
| 28 × 30 | 52% | 0 errors |
| 36 × 21 (the computed minimum) | 58% | 2 errors: a VBUS via beside J1's locating hole (the known autorouter issue, also seen at 45 mm with test pads) |
| Beacon at its minimum, 34 × 26 | 54% | 0 errors |

The logger's brief asks for "about 50 × 30 mm", so the scripted architect records `engineer-size` and the board
stays at that size. The report shows what that costs: 98% over the smallest it can be. A brief that sets no size gets
36 × 21 mm.

## Open

- **The antenna.** The board generator centres the ESP32-C3 module, so its antenna ends up mid-board (16.7 mm from
  the edge at 50 mm), with traces running past it. Espressif wants it at the edge. Fixing this moves every part on
  every board, so it is a separate step.
- **DRC errors don't stop a design from settling.** They show in the DRC pill and the report, and in `fab/README.txt`
  for review before ordering. Compact-by-default makes this matter more: at 36 × 21 nothing wakes the architect to
  record `routing` and grow the board.
- At the minimum size, the sensor ends up about 5 mm from the regulator. Sensirion gives no number to check that
  against, so it is a `function` reason an agent or the engineer has to give.
