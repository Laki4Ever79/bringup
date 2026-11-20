# Mechanics: what a rover's design proves, and how

When a brief asks for a robot (`briefs/rover.md`), the contract gains two fields:
- `motion`: the brief's targets, owned by the architect;
- `mechanics`: motors, wheels, caster, battery, sensor and chassis layout, owned by the new **mechanics** agent.

The rover's design is checked in three layers, from cheapest to closest to reality.

| Layer | What it proves | Cost | Where |
|---|---|---|---|
| Plain checks | Every number against the brief, from datasheet values | milliseconds, every contract change | `src/mechanics/checks.ts` |
| Simulated drive | The rover's **own firmware** drives the physics model over a course | about 1–2 min per build | `src/tools/drive.ts`, `py/mech/drive.py` |
| Bench test | The motor's real speed and current on the real cell | 5 min by hand | `docs/bench-motor.md` (designed, not run) |

## The plain checks

Each check is one violation kind. Like the board and case checks, a violation wakes the agents that own the
fields involved. The report's **Mechanics** section prints every computed value against its limit, from the same code.

| Kind | Checks |
|---|---|
| `mech-torque` | each wheel lifts its share of the weight over the brief's edge (1.5× margin) |
| `mech-climb` | the drive wheels' grip can push the caster up the edge (1.2× margin) |
| `mech-speed` | top speed on the motor's load line (winding resistance, rolling load, pack sag) at the nominal voltage reaches the target; the cruise duty the firmware runs (set for a full pack) is at least 0.3 |
| `mech-stopping` | braking (on the drive wheels' share of the weight; the caster barely brakes) plus one sensor period fits inside the sensor's range, minus the wall distance; and the reading at which the rover turns in place (its sweep about the axle plus 100 mm) is within that range |
| `mech-current` | stall current within the driver's peak per channel, and both motors plus the electronics within the pack's peak |
| `mech-runtime` | the pack lasts the brief's runtime at cruise |
| `mech-voltage` | a full cell is at most 1.3× the motor's rating; the driver covers the cell's range |
| `mech-tipping` | the centre of mass stays 10 mm inside the wheels-and-caster triangle, still and braking |
| `mech-fit` | parts on the plate, the plate level, the sensor's view clear, within the brief's size and mass |
| `mech-wiring` | a motor driver with its four inputs on GPIOs, the sensor's plug on an I2C bus, a battery connector |
| `mech-hw-layer` | the firmware's hardware layer uses the contract's pins |
| `mech-drive` | the simulated drive failed (wakes mechanics and firmware) |

Every number comes from a part in `catalog/mechanics.json`, which cites a datasheet or seller's page, except these
estimates. Every report line that uses one says `(estimate: <name> <value>)`.

| Estimate | Value | Why |
|---|---|---|
| floorMu | 0.6 | rubber on wood, laminate or tile: published tables give 0.5–0.8 |
| rollingCrr | 0.02 | small rubber wheels on hard floors: 0.01–0.03 |
| casterMu | 0.02 | a swivel caster rolls rather than grips, so it barely brakes; the simulation slides it at this friction |
| plaDensityGcm3 | 1.24 | solid PLA; infill makes the real plate lighter |
| motorOvervoltMax | 1.3 | small brushed gearmotors take some overvoltage at a cost in life; 1.3× keeps a 3 V motor off a full 4.2 V cell |
| boardMassGPerCm2 | 0.35 | 1.6 mm FR-4 with small parts |
| packInternalOhm | 0.15 | small 1S LiPo cells with protection: 0.1–0.2 Ω |
| standoffMm | 10 | board standoffs, to clear the battery |

### Drive-train parts (mech-mate)

`mechanics.driveTrain` lists the bought gears, pulleys and belts, sprockets and chains, bearings, shafts, couplers and
lead screws, each naming what it mates with (src/mechanics/drivetrain.ts). The checks: every hub's and bearing's bore
against its shaft (±0.05 mm, estimate); a gear mesh at one module and centre distance m(z1 + z2)/2 (±0.05 mm, estimate);
a belt's or chain's pitch against its pulleys or sprockets, and the centre distance its length sits at (open belt
L = 2C + π(D1 + D2)/2 + (D2 − D1)²/4C; chain Lp = 2C/p + (z1 + z2)/2 + p((z2 − z1)/2π)²/C) between the design's centre
and that plus the tension travel; an even chain link count; a bearing's printed seat 0–0.2 mm over its outer ring
(estimate: FDM holes print undersize); a shaft's rpm and radial load against the bearing's rating; a coupler's two bores;
a lead screw's diameter and lead against its nut. Today's direct-drive rover has none.

## The chassis layout solver

The mechanics engineer picks the parts (motor, wheels, caster, battery, distance sensor, the board connector its cable
plugs into) and calls `layout_chassis` (`src/mechanics/solve.ts`). Code searches the plate (the brief's `maxSizeMm`, or
a system's plate), the track, the axle and caster position and the battery's spot, running the checks above on each
candidate, and returns a mechanics field that passes them, or the checks no layout passes with those parts. It takes
about 25 ms for the reference parts. A mechanics proposal whose layout fails the chassis checks is laid out again by the
solver for the same parts, and the tool result says so: the parts are the engineer's choice, where they go is the
code's. Real models moved parts by hand a few millimetres at a time for 30 revisions without landing on the plate
(real rover run 3, 15 Nov); with the solver the drive passed in the first ten revisions.

### The built chassis against its parts

After the chassis is built, `py/chassis.py` measures the exact common volume of every pair among the printed chassis
and the bought parts it carries: each board's slab on its standoffs, the pack, the motors, the driven wheels, the
sensor breakout and the e-stop's body (OpenCASCADE booleans on envelopes from the spec's sizes; components on a board
aren't modelled). It writes the result to `mounts.json` (`interference`: pairs checked, clashes with their volume and
centre, pairs it couldn't measure), and `part-interference` wakes the mechanics agent for any clash or unmeasured pair.
The 2D fit checks above name the pairs they compare; this check compares every pair. Its first run found the pack
running into the sensor's bracket on three of the four example robots (the solver placed the pack as far forward as the
plate allowed), now also a fit check the solver avoids; and the rover mock's pack standing on the main board's
standoffs, now a check that knows the boards' holes, with the solver moving a board the system doesn't place along the
centre line until its standoffs clear the pack. The idea is text-to-cad's `cad model interference` (MIT).

Rules the real runs taught (15 Nov), each now a check or part of the agents' instructions:
- A design that moves (a motor driver, or requirements naming motors, wheels or a rover) needs the motion field; the
  architect is told when it's missing.
- Robot wiring findings go to the agent that owns the field they name: a missing part to parts, a missing pin to the
  architect. A motor never connects to a GPIO; each motor gets a 2-pin connector on the driver's outputs; the sensor's
  4-pin connector takes no pins (the generator joins it to the board's I2C bus).
- A failed simulated drive goes to mechanics only: the rover firmware is generated from the contract.
- The rover firmware's pin header names every contract pin, so the pin check covers the whole map.

## The simulated drive (firmware in the loop)

The firmware has a thin hardware layer: six functions (`hw_begin`, `hw_motor`, `hw_distance_mm`, `hw_payload`,
`hw_now_ms`, `hw_report` in `templates/fw-rover/src/hw.h`). The board build implements them with the DRV8833 and the I2C sensors.
The simulation build (`esp32c3_sim`) implements them over UART1. Everything else (`rover.cpp`, `main.cpp`) is the same
program in both builds.

A rover that is one board of a system (docs/system.md) gets the product firmware's `include/link.h` and
`linkframe.h`, and its link pins in `hw_pins.h`: `main.cpp` starts the links at boot, polls them every control tick and
sends each payload reading on. The simulation build leaves the links out, because its bridge uses UART1.
On an I2C link the rover is the controller: its distance sensor (0x29) and payload sensor already use its one I2C
controller, so the system checks flag a rover as target (`i2c-target-has-bus`) and a target at the sensor's address
(`i2c-address`).

1. PlatformIO builds the simulation firmware and QEMU boots it, with UART1 on a local TCP port.
2. `py/mech/drive.py` builds the MuJoCo model from the chassis spec: mass, centre of mass, wheels, caster, the motor's
   linear model and the cell's voltage sag.
3. Each control tick (the sensor's 33 ms), the firmware sends `M <tick> <left> <right>`. The bridge steps the
   physics one period and answers `S <now_ms> <distance_mm|-1> <temp_c> <rh>`. Lock-step: the result doesn't depend
   on the host's speed. Full protocol: `templates/fw-rover/SIM.md`.

**The course:** a 2.5 × 2 m room. The rover starts facing a wall 1.5 m ahead, with a step as high as the brief's edge
from 0.6 m on.

| Segment | Passes when |
|---|---|
| edge crossed | the caster (the last wheel) gets past the step |
| no wall contact | no part of the rover touches a wall (its closest corner to any wall is reported) |
| kept its distance | driving forward, it never comes closer to what is ahead than the brief's wall distance |
| turned away | it turns more than 45° from its start |
| kept driving | it travels 0.3 m after turning |
| top speed | it reaches 90 % of the brief's speed |
| peak current | no motor draws more than the driver's peak |

Results go to `drive/rev-N/drive.json` and `trajectory.json`, in the report and on the run page's **Drive** tab.
A firmware that never answers is reported as **not run** within 10 s, not as a hang. Without QEMU or PlatformIO, the
design still settles on the plain checks, and the report says "not proven in simulation".

Run it alone: `npx tsx --test test/mech-drive.int.test.ts` (it needs PlatformIO from `npm run setup`, and QEMU and MuJoCo, both from `npm run setup -- --robotics`; they are robots-only, so a PCB-only setup leaves them out,
and without them the drive is "not run").

## What the simulation found

The first simulated drives showed two things the plain checks had missed:

1. **60 mm wheels can't climb a 1 cm step.** A rigid driven wheel on a floor with grip 0.6 climbs only about 0.14 of
   its radius. The design moved to 80 mm wheels.
2. **A trailing caster that carries too much of the weight stalls at a step.** The first measurement overstated it:
   MuJoCo took the larger friction of the caster–floor pair, so the 38 mm caster dragged against the step's edge at
   the floor's 0.6 and stalled at 1 cm under 42 % of the weight even at full power. Re-measured (15 Nov) with the
   caster sliding at its own 0.02 (`casterMu`), on the scripted rover (247 g, 38 mm caster, 80 mm wheels):

   | Step | From rest, full power: caster share that still climbs | At cruise (0.3 m/s) | `mech-climb` limit (1.2× margin) |
   |---|---|---|---|
   | 3 mm | about 70 % (stalls at 80 %) | 43 % crosses | 44 % |
   | 5 mm | about 50 % (stalls at 60 %) | 43 % crosses | 35 % |
   | 10 mm | about 28 % (stalls at 30 %) | up to about 52 % crosses (stalls at 55 %) | 21 % |

   From rest is the case the check bounds: a rover that stops on an edge, or starts against one, has no momentum to
   carry it. There the check's static limit sits under the simulation's at every height, so it stays as it was. At
   cruise the rover's momentum carries the caster over much more (its kinetic energy is about the work of lifting the
   caster's share 1 cm); the scripted rover (43 % on the caster) crosses 10 and 12 mm at cruise and stops at 14 mm,
   where its 80 mm drive wheels stall first. **The brief's edge stays 3 mm** (floor seams and rug edges, not door
   thresholds): a 1 cm edge is crossed only with momentum, and stalls the rover if it ever stops on one. The
   `mech-climb` check catches it in milliseconds; `py/tests/test_mech_drive.py` (CasterClimbTest) holds the
   from-rest measurement to it.

## Not proven

- **Floor grip and rolling resistance** are estimates. The bench test measures the motor, not the floor.
- **The sensor model is ideal:** a ray with no noise and no cone. The real VL53L0X reads a 25° cone with a few
  percent noise.
- **Bluetooth reporting is compiled, not received.** The board build broadcasts each payload reading as BTHome v2
  (`hw_report` in `hw_board.cpp`, the logger's encoder), but QEMU has no radio, so the simulated drive can't show it
  arriving, and no phone or Home Assistant has received it from a real rover yet.
- **No rover has been built.** The board passes DRC and the chassis is generated, but nothing has been printed,
  assembled or driven.
- **The DRV8833's thermal pad isn't connected** on the board. At these currents (under 0.5 A per motor) it isn't
  needed, but the datasheet recommends it.
