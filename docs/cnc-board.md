# Can Bringup design a 3D-printer or CNC controller board from a prompt?

The question (the user, 15 Nov 2026): "can I simply ask bringup to create CNC board optimized for 3D printing work and
get something resembling what Duet 3D is/was". This is the feasibility check the backlog asks for, before any plan.
Only the product idea is borrowed: no Duet design files or text.

**Answer: not today.** Bringup can make the controller's core (the MCU, USB, its supply, test pads, the case, the
checks) on a chip that runs motion firmware. It can't make the parts that make it a printer board: stepper drivers,
a 12/24 V input, heater and fan outputs, thermistor inputs, and copper sized for current. About 2–3 weeks of work
(estimate, below) gets to a first board worth building: 3 axes, 1 heater, 1 bed.

## What exists today

| Piece | Status | Where |
|---|---|---|
| MCUs that run motion firmware | ESP32-WROOM-32E (FluidNC, grblHAL), STM32F411 and F446 (grblHAL), RP2350 (grblHAL, FluidNC) | catalog/mcu/*.json `motion`, sources read 14 Nov |
| Klipper's MCU side | RP2350 is in mainline Klipper (Kevin O'Connor's PR #6725; RP2350B's extra pins in #7146) | klipper.discourse.group "Support for rp2350 micro-controllers" |
| Board pipeline | parts, placement, autorouting (tscircuit), KiCad DRC, fab files, test pads, debug footprint | src/codegen/circuit.ts, src/tools/board.ts |
| A motor driver | DRV8833 (2 brushed DC H-bridges, 1.5 A), not a stepper driver | catalog/parts.json |
| Power | USB-C 5 V in, LDO to 3.3 V, 1S LiPo charger | three LDOs, one charger in the catalog |
| Case, test kit, firmware build | built and checked | src/tools/enclosure, test kit, PlatformIO |

## What's missing, and what each costs

All costs are estimates for one developer session working the way this repo does: catalog entries with a source per
number, plain-code checks, a scripted design, real builds.

| # | Missing piece | What it takes | Estimate | Risk |
|---|---|---|---|---|
| 1 | Stepper drivers | A `stepper-driver` role; TMC2209 (UART config, STEP/DIR/EN, its sense resistors, VM bulk); generator wiring; a check of driver current against the motor's rated current, and of the UART addresses (MS1/MS2 straps, 4 per bus) | 3 days | medium: the TMC2209's thermal pad and the 2 A peak need the copper in row 4 |
| 2 | 12/24 V input | A power tree beyond USB: a barrel jack or screw terminal, reverse-polarity protection (P-FET), a fuse, a TVS, a buck to 5 V, then the LDO; rail checks for each | 2 days | low |
| 3 | Heater and fan outputs | Logic-level N-MOSFETs with gate resistors and pull-downs, flyback diodes on fans, a fuse per heater; a check of heater power against the MOSFET's RDS(on)·I² and the fuse | 2 days | medium |
| 4 | Copper for current | Trace width per net from its current (IPC-2152), heater and bed nets as wide traces or pours. tscircuit routes every trace at 0.15 mm today; its `<trace>` takes a width, but whether the autorouter honours a width per net is unverified | 3–5 days | **high**: a 10 A bed needs about 5 mm of 1 oz outer copper (estimate); if the router can't, a fixed copper region per high-current net, or the bed switched off-board (an external MOSFET module) |
| 5 | Sensor inputs | Thermistor inputs (4.7 kΩ pull-up to the ADC reference, RC filter), endstops and a probe input (pull-ups, ESD) | 1 day | low |
| 6 | Thermal checks | Driver and MOSFET dissipation against the copper area; ambient in the case | 1 day | medium (estimates of copper's heat spreading) |
| 7 | Firmware configuration | Generate the machine's config from the contract's pin map: FluidNC YAML (CNC), Klipper's printer.cfg (printing); validate with FluidNC's own tools and Klipper's batch mode | 2 days | low |
| 8 | Board size and layers | A printer board is about 100 × 80 mm with 20+ connectors; tscircuit's autorouter on 2 layers at that density is untested; 4 layers is unverified in tscircuit | 2 days to test | **high** |

## The smallest board worth building first

A 3D-printer board without the bed: **3 stepper drivers (X, Y, Z+E shared or a 4th), 1 hotend heater (≤ 5 A at 24 V,
40 W), 1 thermistor, 2 fans, 3 endstops, 24 V in**, with the heated bed switched by an external MOSFET module. That
keeps every net under about 5 A, so row 4's risk shrinks to traces about 2 mm wide (estimate), and the board stays
under 100 × 70 mm.

Firmware: Klipper on an RP2350 (its MCU side is mainline; the host runs on a Raspberry Pi, which Bringup already
treats as a bought compute board), or FluidNC on an ESP32-WROOM-32E for a CNC router instead of a printer. Duet's own
RepRapFirmware is not a target: it runs on Duet's chips, and its port to other boards was not checked here.

## Order of work

1. Row 8 first, because it can kill the plan: a scripted board of the right size and connector count routed on 2
   layers, measured.
2. Rows 2, 4 and 5: power in, current-sized copper, sensor inputs. Without them, no printer part can be checked.
3. Rows 1 and 3: the drivers and the outputs, each with its checks.
4. Rows 6 and 7: thermal checks and the generated firmware config.

Each step is a branch with a scripted design that builds, the way the rover was built.
