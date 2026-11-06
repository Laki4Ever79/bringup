# Production test: the test kit follows the design

Ask for a production test ("add a production test fixture") and a test agent joins the design. It owns one contract
field, `test`: which nets get a test pad, and the current limits a good board stays under. From that field and the rest
of the contract, Bringup builds four things that stay in step:

| What | Where | From |
| --- | --- | --- |
| Test pads: a 1.5 mm round pad per probed net on the board's underside, on a 2.54 mm grid, 3 mm from the edge, clear of the module (its antenna), connectors, the mic's sound hole and the mounting holes | the board (`<testpoint>` in `board.circuit.tsx`) | `src/codegen/circuit.ts` `testPoints` |
| Bed-of-nails fixture: a printed plate with a probe hole under each pad, a nest that holds the board by its outline, and an alignment pin through each mounting hole. Each probe hole is checked open on the built solid | `testkit/rev-N/fixture.stl`, `.step`, `fixture.json` | `py/fixture.py` |
| Factory-test firmware: drives each LED line and reads it back, checks the sensor answers its I2C address, checks the mic's data line moves, checks each button idles high; reports on USB; then deep-sleeps for the sleep-current step | `testkit/rev-N/firmware` (env `esp32c3_test`) | `templates/fw/src/factory_test.cpp`, `include/testkit.h` |
| Test plan: power first, then current, then the self-test, with pass limits and the pad for each step | `testkit/rev-N/test-plan.md`, `.json` | `src/contract/testkit.ts` |

## What keeps them in step

Checks in plain code, like the rest of the contract:

- `test-uncovered`: a signal (or GND, 3V3, VBAT) has no pad. Wakes the test agent: "add a wake word" adds three mic
  pins, and the test agent adds their pads.
- `test-orphan`: a pad on a net the design no longer has. Wakes the test agent.
- `test-limit`: a current limit below the design's own peak or sleep current, so every good board would fail. Wakes the
  test agent.
- `test-unplaced`: no room on the underside for a pad. Wakes the test agent, which drops it. A net the board has no
  room for is then not owed a pad, so the two checks never contradict each other.
- `fixture-mismatch`: a fixture probe not over the pad the built board has, or on another net. Nobody can fix this in
  the run: the fixture and the board come from the same placement code, so it would mean tscircuit put a pad
  somewhere else, a bug to report. Checked on a real build: tscircuit places the bottom pads at exactly the requested
  coordinates.

"Make it 40 mm wide" moves the pads with the parts; the board and the test kit rebuild from the same revision, so the
fixture's holes land under the new pads.

With a charger on the board, the current steps run from a battery simulator on the VBAT pad with USB unplugged: the
limits are the battery-fed rails' current, and with USB in, the charger would add whatever it is charging.

VBUS is optional: the station powers the board through its USB-C port, which it needs anyway to read the factory
test's output. A VBUS pad also pulled a via beside the connector's locating hole on the 45 mm logger.

## Measured (6 Nov 2026)

The logger design with its default test (pads on I2C_SDA, I2C_SCL, STATUS_LED, GND, 3V3, VBAT), built with tscircuit
and checked by KiCad's DRC on JLCPCB 2-layer rules:

| Board width | DRC errors | Unconnected |
| --- | --- | --- |
| 40 mm | 0 | 0 |
| 45 mm | 2 (hole clearance: a VBUS via beside J1's locating hole) | 0 |
| 50 mm | 0 | 0 |
| 60 mm | 0 | 0 |
| 70 mm | 0 | 0 |

The same 45 mm board without pads has 0. The pads change the autorouter's choices near the USB-C connector, and it
drops a via next to a locating hole, which tscircuit doesn't model (the first wake-word board hit the same, 4 errors).
Not fixed yet. The board build keeps the layout with the fewest errors and reports them.

Test kit build on this laptop: plan, fixture and factory-test firmware in about 12 s (firmware from a warm PlatformIO
cache).

## Not done yet

- No bench run: the factory-test firmware compiles, but hasn't run on a board on a fixture. The probe-hole size
  (1.7 mm) is a typical press-fit receptacle figure for 100-mil pogo pins, not one vendor's datasheet.
- The station itself (the meter and the script that reads `BRINGUP-TEST` lines against the plan) is not written.
- The plan's continuity steps for signals without a self-test (a part Bringup has no driver for) only say what the
  fixture should see.
