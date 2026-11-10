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
| `mech-speed` | loaded top speed (0.8 of no-load) reaches the target |
| `mech-stopping` | braking plus one sensor period fits inside the sensor's range, minus the wall distance |
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
| plaDensityGcm3 | 1.24 | solid PLA; infill makes the real plate lighter |
| motorOvervoltMax | 1.3 | small brushed gearmotors take some overvoltage at a cost in life; 1.3× keeps a 3 V motor off a full 4.2 V cell |
| boardMassGPerCm2 | 0.35 | 1.6 mm FR-4 with small parts |
| packInternalOhm | 0.15 | small 1S LiPo cells with protection: 0.1–0.2 Ω |
| standoffMm | 10 | board standoffs, to clear the battery |

## The simulated drive (firmware in the loop)

The firmware has a thin hardware layer: five functions (`hw_begin`, `hw_motor`, `hw_distance_mm`, `hw_payload`,
`hw_now_ms` in `templates/fw-rover/src/hw.h`). The board build implements them with the DRV8833 and the I2C sensors.
The simulation build (`esp32c3_sim`) implements them over UART1. Everything else (`rover.cpp`, `main.cpp`) is the same
program in both builds.

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

Run it alone: `npx tsx --test test/mech-drive.int.test.ts` (it needs `.venv` with MuJoCo, PlatformIO and QEMU from
`npm run setup`).

## What the simulation found

The first simulated drives showed two things the plain checks had missed:

1. **60 mm wheels can't climb a 1 cm step.** A rigid driven wheel on a floor with grip 0.6 climbs only about 0.14 of
   its radius. The design moved to 80 mm wheels.
2. **The trailing caster stalls at a 1 cm step**, even with full motor power. It carries about 42 % of the weight:
   its own 71 g, plus the plate and the board, sit behind the axle. To be pushed up 1 cm it may carry at most about
   21 %. No layout within the brief's 160 mm and no caster in the catalog gets there. **The brief's edge is now 3 mm**:
   floor seams and rug edges, not door thresholds. The `mech-climb` check now catches this in milliseconds.

## Not proven

- **Floor grip and rolling resistance** are estimates. The bench test measures the motor, not the floor.
- **The sensor model is ideal:** a ray with no noise and no cone. The real VL53L0X reads a 25° cone with a few
  percent noise.
- **Bluetooth reporting** of the payload readings is not in the rover firmware yet; it prints them over USB.
- **No rover has been built.** The board passes DRC and the chassis is generated, but nothing has been printed,
  assembled or driven.
- **The DRV8833's thermal pad isn't connected** on the board. At these currents (under 0.5 A per motor) it isn't
  needed, but the datasheet recommends it.
