# Bench test: one drive motor

**Status: designed, not run.** The firmware compiles (`bench_motor` env); no rover hardware has been built yet.

The simulation and the plain checks use the motor's datasheet numbers (catalog/mechanics.json) scaled to the cell's
voltage. This test checks those numbers on a real motor, run by the real driver from the real cell. It takes about
5 minutes.

## What it checks

| Number | Where it's used | Datasheet (POLOLU-2367, 100:1 MP 6V) |
|---|---|---|
| Speed against duty, no load | top speed, cruise duty, stop distance | 220 rpm at 6 V, so about 136 rpm at 3.7 V |
| Current with no load | runtime | 0.07 A at 6 V |
| Stall current | the driver and pack current checks, simulated peak | 0.67 A at 6 V, so about 0.41 A at 3.7 V |

It doesn't measure floor grip (`floorMu`) or rolling resistance. Those stay estimates, and the report says so.

## You need

- The rover board (or any ESP32-C3 with a DRV8833 on the same pins), the motor on JM1 and the cell on its connector.
- A multimeter on its 10 A range **in series with the cell's red lead**. Don't measure on USB: USB powers the board,
  not the motor.
- A marker dot on the wheel, the wheel off the table, and a USB cable for the serial monitor.

## Steps

1. Build and flash: `pio run -d <firmware dir> -e bench_motor -t upload`, then `pio device monitor -b 115200`.
2. The board waits 3 s, then steps the left motor through duty 0.2, 0.3 … 1.0. It holds each step for 10 s and pauses
   3 s between steps. Each step starts with a line `B <duty> 10000`; the run ends with `B end`.
3. During each hold, count the marker's turns over the 10 s and read the meter. Write both in the table below.
4. Stall, at the 1.0 step only: hold the wheel still for **at most 2 s** and read the meter. Longer heats the motor.
5. Send any character in the monitor to run the steps again.

| Duty | Expected turns in 10 s | Turns | Current (A) |
|---|---|---|---|
| 0.2 | 4.5 | | |
| 0.3 | 6.8 | | |
| 0.4 | 9.0 | | |
| 0.5 | 11.3 | | |
| 0.6 | 13.6 | | |
| 0.7 | 15.8 | | |
| 0.8 | 18.1 | | |
| 0.9 | 20.3 | | |
| 1.0 | 22.6 | | |
| 1.0, held | 0 | 0 | (stall) |

The expected values scale the datasheet's speed linearly with voltage × duty, from a 3.7 V cell. At low duty a real
motor runs slower than this line, because of friction in the gearbox.

## Reading the result

- **Speed within 15 % of the line from duty 0.5 up:** the model holds; nothing to change.
- **Slower by more than 15 %:** the rover is slower than the checks think. Change the motor's `noLoadRpm` in
  catalog/mechanics.json to the measured value scaled back to 6 V (measured rpm × 6 / 3.7 at duty 1.0), note the bench
  as its source, and rerun the design: the checks and the simulation pick it up.
- **Stall current over 0.5 A at 3.7 V:** also update `stallA` (scaled the same way). The driver's 2 A peak leaves
  plenty of room, but the simulation's peak current should match.

## Why the board doesn't measure this itself

It has no wheel encoder, and the DRV8833's current-sense pins (AISEN, BISEN) go straight to ground. Adding a sense
resistor and an encoder is a board change for a later revision.
