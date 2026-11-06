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
  edges, and the generator's 1.5 mm gap between parts. Each part reserves what tscircuit counts as its extent: its
  courtyard, measured from real builds (before, pad boxes alone let the battery connector reach 0.3 mm past a 25 mm
  board's edge, and tscircuit then skipped routing altogether). The smallest of those areas is the minimum. A board
  whose courtyards (IPC-7351 nominal, 0.25 mm per side) would cover more than **70%** of it doesn't count as feasible.
  This takes about 0.3 s and is cached.
- **The module's antenna hangs past the edge** (below), so only the module's pad area takes board space.
- **Shrinking keeps the shape.** Among the shapes within the limit, the scripted architect takes the one closest to
  the board's current proportions (a 50 × 30 logger shrinks to 33 × 25, not to a strip).
- **Case:** its body height must clear the connectors' cutouts under the lid's lip and give each wall hole its wall.
  Its footprint follows the board and the antenna.

Placement doesn't prove routing. Only a real board build proves the chosen size, and the router can fail at a given
size for reasons that have nothing to do with density. That is what the `routing` reason is for, and the checks
supply the evidence:

- **KiCad DRC errors wake the architect** (`drc-errors`, from the board built at the contract's current size), as
  does a board build the router couldn't finish: unrouted pins, a via dropped on a pad, no spot for a part. The
  architect gives the router room (the scripted one: 2 mm wider, up to five times) and records `routing` with the
  failed build. A layout that would leave a part out is never built: tscircuit would drop that part at the board's
  centre, on top of another.

## The antenna: at the board edge, hanging past it

Espressif, *ESP32-C3 Hardware Design Guidelines*, "Positioning a Module on a Base Board": "place the module's on-board
PCB antenna outside the base board", "the feed point of the antenna close to the edge of the base board", "the module
should not be placed in the center of the board", and keep the USB port "as far away from the antenna as possible".

The board generator puts the ESP32-C3-MINI-1 at the edge opposite the USB-C port, centred along it (or at the
nearest free spot along it). The pad area stays 0.5 mm inside the edge (copper to edge), so 4.9 mm of the 5.4 mm
antenna hangs past the board. The silkscreen stops at the edge. The sensor sits halfway between the regulator and the
module against a side edge, at least 15 mm from both on the 50 × 30 logger. The microphone sits against the other
side edge.

What follows the antenna:

- **The case** leaves it the same 2 mm clearance as the board's edges: it is built around the board plus the
  overhang. Code checks on the built solids that nothing of the case or lid touches the antenna. A "make the case
  50 mm wide" request now means a 37.1 mm board (50 − 2 × 4 mm of wall and clearance − 4.9 mm of antenna).
- **The test fixture's** nest wall has a notch where the antenna passes (measured: no material in its path).
- **Not done:** Espressif also recommends "a clearance of at least 15 mm in all directions" inside the housing, and
  ground copper with vias near the antenna. The case gives 2 mm, and the board has no ground pour. Keeping 15 mm of
  room would be a `function` reason to make the case bigger. The guide asks for the end product to be tested for
  range and throughput; nothing here was.

## Why these numbers

| Number | Source | Status |
| --- | --- | --- |
| 70% courtyard density ceiling for 2-layer routing | J. Watson (Altium), "Density Feasibility: Putting 10 lbs in a 5 lb bag", I-Connect007, 18 Nov 2020, citing IPC-2221 §3.6.2 (Level A 70%, B 80%, C 90%). PCBWay's glossary: above 75-80%, a board may need more layers | Rule of thumb. The IPC text itself is paywalled; we did not see it |
| 0.25 mm courtyard excess | IPC-7351B nominal level, through secondary sources (they quote 0.10-0.25 mm for small chips) | Added on top of the measured courtyards, so the minimum errs bigger |
| 15% allowance | No standard gives a percentage over the minimum outline. This is project policy, applied on top of a minimum that already includes the density ceiling and the keep-outs | Policy |
| Antenna past the board edge | Espressif, *ESP32-C3 Hardware Design Guidelines* (above) | Followed |
| 15 mm clearance around the antenna in the housing | Same guide | Not met (2 mm); see above |
| Sensor away from MCU and regulator heat | Sensirion, *SHTxx/STSxx Design Guide* v1.1 (2019): "sufficient distance", slits; **no mm figure** | Why `function` is a reason, not a number |

## Measured (6 Nov 2026, real tscircuit + KiCad builds, JLCPCB 2-layer rules, the antenna at the edge)

| Design | Size | KiCad DRC |
| --- | --- | --- |
| Logger | 50 × 30 (the brief's), 45 × 30 | 0 errors |
| Logger | 33 × 25 (compact), 30 × 27 (the computed minimum) | 0 errors |
| Beacon | 50 × 30, 37 × 25 (compact), 34 × 26 (minimum) | 0 errors |
| Wake-word logger | 50 × 30, 35 × 26, 37 × 26 | 0 errors |
| Wake-word logger | 33 × 26 (minimum) | 2 errors: a VBUS via beside J1's locating hole. The architect widens to 35 × 26, which routes clean |
| Wake-word logger | 35 × 25 (compact) | Build fails: the router dropped a via on a module pad. The architect widens it |

The logger's brief asks for "about 50 × 30 mm", so the scripted architect records `engineer-size` and the board
stays at that size. The report shows what that costs: 85% over the smallest it can be. A brief that sets no size gets
33 × 25 mm.

## Open

- On a compact board the sensor ends up closer to the heat: on the 33 × 25 logger, 9.8 mm from the regulator and
  14.3 mm from the module, against 16.3 and 22.6 mm at 50 × 30. Sensirion gives no number to check that against, so
  keeping it further away is a `function` reason an agent or the engineer has to give.
- The 15 mm antenna clearance inside the housing and a ground pour near the antenna (above).
