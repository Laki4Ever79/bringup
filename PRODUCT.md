# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
- **Primary: robot builders of mixed skill** (students, Eurobot and university teams, hobbyists building a first robot)
  and **hardware engineers**, served in layers: a clear story of what is happening by default, full engineering depth
  (generated files, checks, contract fields, logs) one step away. Confirmed by the user, 25 Nov 2026: "Both, layered".
- Situation: they describe a device or robot in a sentence, then watch concurrent agents design it, and step in while
  it is still building instead of waiting for the end.

## Product Purpose
Bringup turns a short brief into a consistent hardware design: parts (BOM with JLCPCB numbers and live stock), routed
PCB, printed parts / case whose cutouts match, firmware that compiles against the real pin map, simulations (drive in
MuJoCo, firmware in QEMU, SPICE), a ROS 2 package, and a consistency report. Success: a design that settles with 0
violations and that the user understood and steered on the way.

## Positioning
One live design contract shared by concurrent Mozaik agents: "Change “one thing”, and the whole hardware design
follows: board, printed parts, firmware and parts, in parallel." A change wakes only the agents it affects; plain code
checks every change across domains; the real tools build every revision. Exhaustive checks plus a logged history of
every change are the moat.

## Operating Context
- The web dashboard (`npm run dashboard`, src/dashboard/) on desktop and phone: Home (start from a brief), Designs,
  a design's system page (boards, cables, 3D/Top), and a board's run page.
- Runs are local (Linux, Docker, repo-local toolchain), scripted (free) or real-model; recorded runs replay.
- During a run the user can, at all times, type any change and agents pick it up. They can pause, make changes
  (edit fields/files) and resume; the changes are compiled and verified first, and if they would break the design the
  product suggests fixes, unless the user insists (user, 25 Nov 2026). They can pause, stop or redo one agent or step.
- After the robot is done, the user controls the simulation: drive it live (keyboard, joystick, touch), change the
  scenario (obstacles, room, payload, battery, grip) and rerun, replay and scrub recorded runs and compare revisions,
  and run the generated firmware in the loop (QEMU) with its serial output visible (user, 25 Nov 2026).

## Capabilities and Constraints
- Terminology: brief, design, system, board, run, revision (rev N), contract field (requirements, outline, connectors,
  rails, parts, pins, motion, mechanics, assembly…), agent (Architect, Parts, Firmware, Reviewer, Mechanics…),
  builder (board, chassis, drive, firmware build), check (Consistency, Grounding, Review, DRC), change control,
  settled / unsettled.
- Every UI must work natively on all screen sizes, 320 px phones to 2560 px desktops, touch and mouse (user, 25 Nov 2026:
  "all of this UI should perform meticulously on all screen sizes… it should appear as native").
- Paid model runs are rare and logged; scripted runs are free and are the default for demos.
- Open source, Apache-2.0.

## Brand Commitments
- Name: Bringup. Tagline direction: "Robotics, democratized". The headline line above is user-chosen.
- Never claim a board or robot was physically built until one is (README status line).

## Evidence on Hand
- Recorded runs in out/ (e.g. 20261120-235130 "indoor rover", system-20261120-223755 rover with a Raspberry Pi 5);
  docs/runs/ evidence; docs/img/hero.gif; the 3-minute demo video. No testimonials, customers or benchmarks beyond
  docs/experiment.md; do not invent any.

## Product Principles
1. Show the work as it happens: the user can follow and understand every step, not just the result.
2. The user can steer at any moment; the product protects the design (compile, verify, suggest fixes) without
   overruling an informed user.
3. Layered depth: the story first, the engineering one step away, nothing hidden.
4. Every number and part shown comes from the real run; never fake data.
5. Native on every screen.
