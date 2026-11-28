# A desktop CNC, one-shot (step 0: what's missing)

The goal (the user, 25 Nov 2026): "add to backlog CNC example for the home page. In fact, we should fix all issues we
face along the way of trying to one-shot a CNC". The brief is `briefs/cnc.md`: a desktop 3-axis engraver/router, about
300 × 200 × 50 mm of travel, NEMA 17 motors on T8 lead screws, a spindle of up to 100 W on 24 V, limit switches, an
emergency stop, one 24 V brick, FluidNC or grblHAL on the board's pin map.

The finish line is a one-shot by the real agents. The scripted design (the mock) is the pipeline's test, not the
product: every piece of design knowledge the mock has to hand-write is a gap the agents lack, and becomes a fix in their
prompts, the catalog or the checks.

## Before (26 Nov 2026, adopt)

`npm run bringup -- briefs/cnc.md --mock` designs the battery data logger: `scriptedDesignFor` knows Eurobot, the
rovers, the beacon and the STM32 logger, and gives every other brief the logger (MCU, SHT40, charger, LiPo). No motor,
no driver, no 24 V input. The real agents have no contract field to put a machine in either.

## The gaps, in pipeline order

| # | Gap | Where | Kind |
|---|---|---|---|
| 1 | No contract fields for a machine: `cncTargets` (architect: travel, feed and rapids, the cut, spindle power, repeatability) and `cnc` (mechanics agent: three axes, each with its motor, lead screw, rails, travel and driver current; the spindle; the limit switches; the emergency stop; the brick; the frame). The arm's pair (`armTargets`/`arm`) is the pattern | src/contract/types.ts, shape checks, owners | contract |
| 2 | The architect's requirements can't say "machine": no CNC in its prompt, no peripherals for motors/spindle/limits | src/agents (architect prompt) | agents |
| 3 | No scripted CNC design for the mock | src/inference/scripts.ts | pipeline test |
| 4 | No stepper motor in the catalog (py/parts has a NEMA 17's geometry, catalog/mechanics.json has no `steppers`) | catalog/mechanics.json | catalog |
| 5 | No stepper driver: no `stepper-driver` role, no TMC2209 (STEP/DIR/EN, UART address straps, sense resistors, VM bulk) | catalog/parts.json, board generator | catalog, board |
| 6 | No spindle and no switch for it: a spindle part (24 V, ≤100 W), a logic-level MOSFET with its flyback diode and gate resistor, a PWM speed input | catalog, board generator | catalog, board |
| 7 | No limit-switch or probe inputs (connector, pull-up, RC filter, ESD) | catalog, board generator | catalog, board |
| 8 | Linear rails and a frame: the catalog has one 200 mm lead screw and its nut; no rails, couplers sized for NEMA 17 (5 mm → 8 mm exists), 20-series extrusion as a part (py/parts has its geometry) | catalog/mechanics.json, py/parts | catalog, CAD |
| 9 | Checks a CNC needs: driver current vs motor rating; TMC2209 UART addresses unique per bus; the brick's budget (three motors + spindle + logic); the spindle MOSFET's RDS(on)·I², flyback and fuse; travel vs the work area; axis thrust (motor torque through the lead screw) vs a cutting-force estimate; step resolution vs repeatability; rapids vs the motor's speed curve | src/contract, src/mechanics | checks |
| 10 | Wide copper for the spindle (~4.2 A) and the motors' VM: the same case as the arm's servo rails, solved on bringup-lead-4's arm-board branch (Freerouting at 0.2 mm, freeroute.py widens wide nets afterwards, the refill fixes pours, a corridor reservation next) | src/tools/board.ts, py freeroute | board (reuse) |
| 11 | Firmware: generate FluidNC's config.yaml from the contract's pin map (or grblHAL's map.h); build FluidNC itself (a download: ask first) | src/tools/firmware.ts, templates | firmware |
| 12 | Simulation: no CNC sim yet (a MuJoCo gantry driven by the firmware, or at least the G-code's moves against the work area). Espressif's QEMU emulates the classic ESP32 (the WROOM-32E's chip) with its I2C and more peripherals than the S3/C3 | later | sim |
| 13 | Save as a private example with pictures (examples/ is private) | scripts | example |

## Order

1. The contract fields (gap 1) and their shape checks, frozen like the arm's, so agents and builders share one machine.
2. The catalog (gaps 4–8), each number with its source.
3. The scripted design (gap 3) on those fields, and the mock run: every builder or check that fails on it is logged
   below and fixed in code.
4. The checks (gap 9), the board on lead-4's wide-copper path (gap 10), the firmware config (gap 11).
5. The agents' prompts (gap 2) last, so they write what the mock proved the pipeline can build; then one real run with
   the user's yes.

## Log

Each failure on the way, with its general fix.

- 26 Nov: a CNC brief designs a data logger (gap 3). Fix: the CNC scripted design on the new fields.
- 26 Nov: gap 1 done: `cncTargets` (architect) and `cnc` (mechanics), their shapes (src/cnc/shape.ts: axes x, y, z in
  order, unique TMC UART addresses, microsteps a power of 2, firmware fluidnc|grblhal). On the way: a machine tool's
  requirements without those fields were told to write a rover's `motion` (the "moves but has no motion targets"
  check reads "motors"); now a CNC, router, engraver, plotter, stepper or spindle asks the architect for `cncTargets`.
- 26 Nov: gaps 4 and 8 (mechanics catalog): a stepper (StepperOnline 17HS15-1504S1: 1.5 A, 0.45 N·m, its pull-out
  curve at 24 V), the HIWIN MGN12H rail, T8 screws of 300 and 400 mm, the Genmitsu GS-775MR spindle, each number
  sourced. On the way: the 17HS4401S everyone names has no maker's page any more (StepperOnline sends its search to the
  17HS15-1504S1); no maker states a hobby 775 spindle's power or current, so the spindle's 75 W and 3.1 A are listed as
  estimates. Gap 9 (checks, src/cnc/checks.ts): parts in the catalog, each screw's length for its travel, driver
  current against the motor and the TMC2209's 1.4 A continuous, one full step against the repeatability, the torque
  at the rapid speed (pull-out curve) against the axis's load through the screw, the brick's watts. The load model's
  constants are estimates, named in the code (wood's cutting force 50 N/mm², screw efficiency 0.3, moving masses,
  500 mm/s², ×2 margin). Still open in gap 5/6: the TMC2209 and the spindle's MOSFET as board parts.
- 26 Nov, mock run 1 (`briefs/cnc.md --mock`, 126 s): UNSETTLED at revision 8, 2 violations, 0 failed builds.
  `cnc-fit` stayed open: the mechanics agent only woke for `mech-*` violations, so neither the CNC's `cnc-*` nor the
  arm's `arm-*` ever reached it (a general bug: on adopt a real arm run's violations never woke it either). Fix, made
  general on adopt (0584fe7, src/agents/recipients.ts): every agent wakes on the violations addressed to it, never on a
  kind's name; and the mechanics agent's instruction now says what a CNC's `cnc` field holds (CNC_SHAPE).
  `sensor-unwired` (the logger's SHT40 on a CNC): the scripted parts agent gave every unknown design the logger's parts.
  Fix (mock only): the CNC's parts for a CNC.
- 26 Nov, mock run 2 (5 s): UNSETTLED at revision 8. The mechanics agent now wrote `cnc`; the parts agent's list was
  refused twice: "U1 ESP32-WROOM-32E is not in the catalog". The WROOM-32E has an MCU profile (compare_mcus ranks it for
  FluidNC) but `board.supported` is false: its land pattern isn't entered and, with no native USB, it needs a USB-UART
  bridge with the auto-reset transistors. New gap 14: a buildable board for the WROOM-32E (or FluidNC on the RP2350).
  Today the buildable motion chips are the STM32F411CEU6 and F446 (grblHAL), so the scripted CNC moves to the F411 and
  grblHAL; the real agents' compare_mcus already ranks buildability.
- 26 Nov: gap 2 begun (the agents' prompts): the architect's prompt describes `cncTargets` (CNC_TARGETS_SHAPE, beside
  armTargets) and the mechanics engineer's the `cnc` field (CNC_SHAPE); bringup-lead-5's field-prompts guard
  (test/field-prompts.test.ts) found the architect's missing the moment the branch met it.
- 26 Nov: gap 5 begun: the TMC2209-LA in catalog/parts.json (role stepper-driver; pins, the QFN28 footprint with its
  3.7 mm exposed pad, VS 5.5–29 V, 1.4 A RMS, 2.8 A peak, 4 UART addresses, each from the datasheet rev 1.09); the
  driver-current check reads its 1.4 A from there; the parts agent's prompt names the role. The scripted board carries
  four (U4–U7, one per motor) unwired: the board generator doesn't wire a stepper driver yet (next).
- 26 Nov, mock run 3 (7 s): the parts list with the four TMC2209s refused: "part role must be one of …" — the contract's
  PART_ROLES didn't name stepper-driver although the catalog now had one. Fix: the role, and a test that every role
  in catalog/parts.json is one the contract accepts (test/part-roles.test.ts).
- 26 Nov, mock run 4 (399 s): the parts went in, revision 14, 0 violations, but 7 of 8 board builds failed:
  "Pads U6.OA1 and unnamed SMD pad are too close (clearance: 0mm)". tscircuit's QFN28 at its default pad length ran
  every pin into the 3.7 mm exposed pad. Fix: the land pattern from the datasheet's package data (§22.1: lead 0.25 ×
  0.4 mm; pads 0.25 × 0.75 mm, 5.8 mm toe to toe, 0.2 mm from the pad: derived, an estimate), and a test that every
  catalog footprint tscircuit draws keeps its pads 0.1 mm apart (test/footprint-clearance.test.ts; the generator's own
  land patterns, circuit.ts ownFootprint, are skipped).
- 26 Nov: the 24 V brick: Mean Well GST160A24-R7B (24 V 6.67 A 160 W, 93 %; its plug is a 4-pin locking mini-DIN,
  IEC C14 inlet, cord not included; datasheet 2026-04-03) in powerBricks; the scripted CNC takes 24 V 6.67 A; a CNC
  whose brick the catalog can't supply is a cnc-parts finding. On the way: the parts list took the first brick that
  fits, not the smallest (robot-parts.ts); it now picks the smallest of the input's volts that gives its amps.
- 26 Nov, mock run 5 (458 s): the pads cleared, but 7/8 board builds failed on placement: "Courtyard of U5 overlaps
  with courtyard of C4", pads 0.075 mm apart between drivers. The placer's size table (circuit.ts FOOTPRINT_SIZE) is
  hand-kept and gave the unlisted QFN28 its 3 × 3 mm default. Fix: a quad package whose string states w/h is sized from
  it, + 0.25 mm a side (circuit.ts quadSize), so the next new QFN/LQFP part needs no table row.
- 26 Nov, mock run 6 (62 s): SETTLED at revision 9, 0 violations, 0 failed builds, and wrong: no pins at all, no 24 V
  rail, four TMC2209s wired to nothing. A false settle: no check asked for a driver's inputs. Fix: cnc-wiring asks for
  each stepper driver's STEP, DIR and ENN on MCU GPIOs and for a rail at the brick's volts for VS (to the architect).
- 26 Nov, mock run 7 (76 s): UNSETTLED at revision 9 with exactly those 5 findings (4 drivers × STEP/DIR/ENN, the 24 V
  rail), 0 failed builds. Next: the board generator wires a stepper driver (its VS from the 24 V rail, the charge pump,
  5VOUT, the sense resistors, the motor connector, the UART), then the scripted design assigns the pins.
- 26 Nov: gap 5, the board side: the TMC2209-LA's catalog entry carries its wiring (nets) and parts (support) for
  bringup-lead-4's chipSupport (src/codegen/chip-support.ts): VS on the motor rail with 10 µF 50 V + 100 µF 35 V, the
  charge pump (22 nF 50 V CPI–CPO, 100 nF VCP–VS), 4.7 µF on 5VOUT, VCC_IO decoupled on 3V3, CLK/STDBY/pin 25 to GND,
  PDN_UART on one line for all four (@STEPPER_UART), MS1/MS2 strapped per motor, a sense resistor per coil computed
  for the run current (0.15 Ω for 1.2 A: 1.35 A full scale; src/cnc/board.ts). Each motor's plug is a contract part
  (JST B4B-XH-A, 3 A) whose pins name the driver's output nets (Part.nets "@X_A1"…; a typo reports
  part-net-unknown). The scripted board: VMOT 24 V from the DC jack, STEP/DIR/ENN for X, Y1, Y2, Z on PA0–PB12, the
  UART on PA9. Its consistency check leaves only space-slack (the board's size), which the architect shrinks.
- 26 Nov, mock run 8 (1754 s, under a load of ~24 from another session's tests): the drivers wired, revision 13,
  0 violations, but 6 of 7 board builds failed: "Courtyard of JX1 overlaps with courtyard of C7"… The placer didn't
  know the JST XH plug's size either (3 mm default; its courtyard is 13.4 × 6.75 mm). Fix: its size from tscircuit's
  own courtyard, and a test that every catalog footprint has a placement size (test/footprint-size.test.ts), so the
  next new part can't be placed blind. Also seen: "the 5 mm maximum length for U4.VS to C11.pin1 cannot be satisfied
  (6.12 mm)", to recheck once the plugs no longer crowd the drivers.

- 26 Nov 2026, mock 8 → 11. The 6.12 mm capacitor: the reach check had no pad ring for a non-MCU QFN and skipped every
  driver capacitor; later parts took earlier parts' reserved capacitor spots; VCP-to-VS sat beside VCP only. Fixed in
  placement for every board (QUAD_RING_MM, reserved spots kept free, a two-side capacitor between its pads, VCP to VS2):
  10 capacitors out of reach → 0. Mock 9 built a clean board (0 DRC errors) but ended on it: it was built before
  mechanics wrote cnc, and nothing counted the drivers' context as a board input. Fixed twice over: the board's derived
  key holds every chip's context, and "current" compares derived keys (mock 11: the board rebuilds at revisions 8-11).
  The scripted architect read the work area's "200 × 50 mm" as the board size; fixed. Open: the four-driver board
  doesn't route on 2 layers (tscircuit "over 50 traces remaining", Freerouting 3-6 pins unrouted): bringup-lead-4's
  4-layer fallback, triggered by unrouted connections.
- 26 Nov 2026, gap 6, part 1: the logic's 5 V from the brick. The board ran its MCU from USB only: unplugged, the
  machine had no controller. A CNC's DC jack is now a machine input as an arm's is (circuit.ts machineInput, on the net
  its jack names: VMOT at its rail's 24 V): the power tree adds a 5 V step-down rated over the input TVS's clamp and two
  Schottkys OR'ing it with VBUS (power-auto.ts brickLogicTree, shared with the arm), and the jack gets the arm's TVS and
  bulk capacitor. Part 2, the spindle switch, is next: a 3.3 V GPIO can't drive a power MOSFET whose RDS(on) is
  specified only at 4.5 V and up (no 30 V part with a 2.5 V rating in a power package turned up), so a 5 V AHCT buffer
  (SN74AHCT1G125, C7484: TTL input, VIH 2.0 V) drives the gate from the new 5 V; its OE is where the emergency stop will
  cut the spindle in hardware (gap 7). Flyback: SS54 (C22452, JLCPCB basic, 40 V 5 A, SMA).
- 26 Nov 2026, gap 6, part 2: the spindle switch. SPINDLE_PWM (TIM1_CH1, PA8) into the AHCT buffer U8 on the 5 V; its
  catalog support adds the 120 Ω gate resistor, the 100 kΩ gate pull-down (off in reset or while OE is high) and the SS54
  flyback (cathode on VMOT); Q1 AO4468 (C87410: 23 mΩ max at 4.5 V; SOIC-8) switches the spindle's minus lead; J3 a
  KF128R 5.08 mm 24 A terminal. Checked against the datasheet (lead-2's ask): a stall is limited by the 6.67 A brick,
  about 1.3 W in the MOSFET, Tj ≈ 125 °C at 25 °C ambient (an estimate, under its 150 °C maximum but marginal: the
  firmware should stop a stalled spindle, gap 11); avalanche (IAS 19 A, EAS 18 mJ) only without the flyback. Found on the
  way: the catalog's KF301 input terminal names its pins VIN/GND, and every pin named GND joins ground, so it could not
  carry the spindle's minus lead; hence a terminal of its own. Also found: compactOutline takes ~94 s on this ~70-part
  board (~260 layouts of ~0.36 s; 75 s of it without the reserved-spot check), and every consistency check calls it:
  a speed fix for large boards, logged for the space check's owner.
- 27 Nov 2026, gap 7: the emergency stop and the limit switches. The rover's e-stop puts its A22E's NC contact in the
  motors' supply; the CNC can't: the contact breaks 1.5 A of inductive load at 24 V DC, the brick feeds 6.67 A into four
  steppers and a spindle. So the contact holds a P-FET's gate loop (AO4407A, C16072; role estop-switch): VMOT (the
  brick, where the logic's step-down stays) to VMOT_SW (the drivers' VS and the spindle). Pressed, or its cable cut, the
  loop opens and the gate goes to the source: off in hardware, the MCU still up to report it. The gate network is the
  part's catalog support: a 1k/1.2k divider (10.4 mA at the brick's -5 %, over the contact's 10 mA minimum load; VGS
  about -10.9 V, -11.5 V at +5 %), a 15 V Zener clamp (under the FET's 25 V), a 47k with a 100 nF gate-drain capacitor
  for a soft start (about 0.74 A into the drivers' 440 µF over about 14 ms) and a 1N4148W around it for a fast turn-off
  (about 1.0 ms, about 84 mJ, under the part's 101 mJ repetitive avalanche rating, for scale); all ESTIMATES from a
  first-order gate model (src/cnc/estop.ts, checked on every revision). The same trip, divided to 3.1 V (ESTOP_TRIP),
  disables every driver through an OR gate on their now shared ENN (SN74LVC1G32, C19829663; STEPPERS_EN from the MCU)
  and the spindle's buffer (its OE), and the MCU reads it: outputs off even if the FET failed short. Each axis' limit
  switch (NC to GND) on a side-entry JST XH plug with a 10k pull-up and 100 nF filter. Firmware requirement for gap 11
  (lead-2): releasing the e-stop brings VMOT back but nothing resumes by itself: grblHAL stays in alarm until reset, the
  spindle's gate stays off by its pull-down until the firmware enables it.
  Found on the way: a pin the name rules join (VCC to 3.3 V, GND to ground) is no longer joined when the contract or a
  chip's catalog entry wires it elsewhere: the spindle buffer's VCC sat on 5 V and, by its name, on 3.3 V, shorting them
  (gap 6's design, caught by the gap 7 test); the plugs are their own catalog parts (the datasheet check refuses pins
  renamed per design); header pads (pinrowN) are known to the reach check.
- 27 Nov 2026, gap 11 (part 1): grblHAL's configuration from the contract, without its download. The firmware folder
  gets grblhal/my_machine_map.h (the STM32F4xx driver's board map: per-axis STEP/DIR ports, the ganged Y2 as M3, the
  shared enable, the limits, the spindle's PWM, the e-stop's trip as RESET, the drivers' shared Trinamic UART),
  settings.txt ($100-132 from the stepper's step angle, the microsteps, the screw's lead, the rapids and the travel;
  limits and homing on; $64=1, the boot alarm forced: the no-restart requirement) and README.txt (how to build grblHAL
  with it). Macro and setting names read in grblHAL's sources (STM32F4xx boards/, Src/tmc_uart.c; core settings.h);
  what they didn't settle is marked UNVERIFIED in the files (TRINAMIC_STREAM's number, the NC inputs' polarity, the
  custom-board recipe). cncChecks reports a signal the map needs that has no pin. Found on the way, a board bug: grblHAL's
  shared Trinamic mode is a full-duplex USART (addresses by motor index: X 0, Y 1, Z 2, M3 3, as our straps), and the board
  had only PA9 (TX) straight on PDN_UART, so it could write the drivers and never read them back; now RX (PA10) is on
  the line and TX joins it through 1 kΩ (R20). Open: the spindle's stall stop needs a current sense the board doesn't
  have; building grblHAL itself (its repository with submodules, tens of MB, project-local) is the next step.
- 27 Nov 2026, gap 11 (part 2): grblHAL builds for the board. Its STM32F4xx driver cloned into the gitignored tools/
  (39 MB with submodules; GPLv3, so never copied into this repo, where only our generated map and settings live):
  `git clone --depth 1 --recurse-submodules --shallow-submodules https://github.com/grblHAL/STM32F4xx.git
  tools/grblhal-STM32F4xx`. Its source settled what part 1 marked unverified: USART1 is SERIAL_PORT 1 (PA9/PA10), the
  Trinamic stream instance 0 (its default, 1, is a second serial port); NC switches to ground are its default polarity
  ($5=0, $14=0); an asserted e-stop raises the EStop alarm ("blocks everything until cleared") and after the reset it
  stays in alarm until unlocked. First build: two errors, both fixed in the generated files, not in grblHAL: the probe
  input on by default with no probe pin (PROBE_ENABLE=0), and the PWM-only spindle not building upstream (driver_spindles.c
  calls a one-argument spindle_dir() with two), so the spindle is PWM without direction, its enable on a spare GPIO wired to
  nothing. Built 27 Nov 2026 (STM32F4xx b0cd1bb): RAM 16.9 %, flash 41.9 % (test/cnc-grblhal.int.test.ts, skipped without
  the clone). The firmware folder's grblhal/ now has platformio_env.ini too.
- 27 Nov 2026: the spindle's stall stop, its hardware. A stall draws up to the brick's 6.67 A and cooks the AO4468 (about
  1.3 W, Tj about 125 °C), so the board measures it: a 10 mΩ shunt under the MOSFET's source (VMS-R010-1.0-U, C466594,
  2512, 4 W; 0.44 W and 67 mV at 6.67 A) and an INA180A1 (C122228, 20 V/V, pinout A) on 3.3 V to PA5 (ADC1_IN5, SPINDLE_I):
  16.5 A full scale (3.3 V / (20 × 10 mΩ)); the 3.1 A run current reads 0.62 V. Gain 50 would have saturated at 6.6 A,
  under the brick's current. Its output takes at most 1 nF (TI: no sustained oscillation), so the filter is 1 nF and the
  firmware averages: the low-side shunt sees the current only while the MOSFET conducts, so the average is divided by the
  duty. The check (src/cnc/estop.ts spindleSenseChecks): a switched spindle with no current sense, a full scale under
  the brick's current, or its output on no pin, each reported. Open: grblHAL has no stall stop of its own; the plugin that
  reads SPINDLE_I is still to write.
- 27 Nov 2026: the spindle's stall stop, its firmware. A grblHAL plugin, generated with the board's numbers
  (src/cnc/stall.ts; the firmware folder's grblhal/bringup_stall.c and .h, copied into grblHAL's Src/): my_plugin_init
  sets up ADC1 on SPINDLE_I's pin (PA5, channel 5) and chains grbl.on_execute_realtime; every millisecond it reads the
  INA180, averages over 20 ms, divides by the PWM duty (from the spindle's own get_pwm and period) and, when the motor's
  current stays over the trip for 300 ms, turns the spindle off (spindle_set_state) and raises grblHAL's spindle alarm
  (Alarm_Spindle, 14). The trip, 6.0 A, is an ESTIMATE (no maker states a 775 spindle's stall current): twice its 3.1 A
  run current, held under 0.9 of the brick's 6.67 A; under 10 % duty nothing is judged. The detector is a pure header,
  compiled with the host's gcc in test/cnc-stall.test.ts: a run never trips, a stall and a stall at the brick's full
  current trip at 300-400 ms, a 150 ms load step and a low-duty stall don't. Built into grblHAL (the plugin linked:
  my_plugin_init, stall_poll in firmware.elf); the build environment now goes in grblHAL's platformio.local.ini (its
  platformio.ini reads it, git ignores it), so grblHAL's own files stay as cloned.
- 27 Nov 2026, found by gap 12's first Renode boot ("PWM spindle failed to initialize"), two real-board bugs in the
  generated map: grblHAL claims a PWM timer for the spindle only through an auxiliary output (Src/driver_spindles.c
  aux_out_claim_explicit), so naming SPINDLE_PWM_PORT directly left the spindle without one; the spindle's PWM and enable
  are now AUXOUTPUT0/1 and the e-stop's RESET input AUXINPUT0, as grblHAL's BlackPill map declares them (the warning is
  gone in Renode). And the gantry's second Y motor (M3) needs Y_GANGED=1 to step with Y; without it grblHAL left it idle.
- 27 Nov 2026, gap 12 (part 1): grblHAL in the loop, in Renode. src/tools/cnc-sim.ts generates the simulation from the
  contract: an overlay on Renode's STM32F412 model (no F411 in Renode 1.17) with the DWT at 96 MHz (grblHAL's µs timing),
  a small Python ADC1 (the spindle current, set by the scenario) and TIM5 at 96 MHz; a hook reloading TIM5's counter from
  ARR (Renode's model doesn't, for a down-counter, so grblHAL stepped once and stopped); the step pulses counted on each
  motor's STEP pin from the GPIO writes; and a scenario: our settings, a move X2 Y1 Z-0.5, the e-stop pressed and
  released, a stall injected, X's limit tripped. Run on grblHAL's simulation build (console on USART1, no USB, no
  Trinamic; generated beside the board's in platformio.local.ini): X 800, Y 400, M3 400, Z 200 step pulses, exactly the
  move times 400 steps/mm, Y's two motors equal; the stall plugin's ALARM:14 on the injected current; about 13 s of wall
  time. Open: the e-stop's and limit's inputs (PB12, PB13, driven with Renode's OnGPIO) don't reach grblHAL yet; the
  run as a build kind (cncsim) in every CNC design run. Found on the way: settings sent in number order gave error:10
  ($20 soft limits before $22 homing): homing now comes first in settings.txt.
- 27 Nov, mock run 16 (`briefs/cnc-fluidnc.md --mock`, 30 min, the CNC on FluidNC and the ESP32-WROOM-32E): UNSETTLED at
  revision 9, 5 violations. The USB-UART bridge and auto-reset pair arrived on their own; the pins had no FluidNC
  problem. `firmware-build-failed`: the product firmware's console logged on the chip's USB Serial/JTAG ("'HWCDC' does
  not name a type"), which the classic ESP32 doesn't have. Fix, general (templates/fw/include/hal.h): the USB log is
  the soc's capability (SOC_USB_SERIAL_JTAG_SUPPORTED), UART0 alone otherwise; the mock's own firmware dir now builds
  (RAM 11.4%, flash 64.8%), C3 and S3 too. The other four (U8.VCC unwired, U11/D10/D11 missing) are the board built at
  revision 6, before the power tree; the revision-9 board is the CNC's routing density (">50 traces left unrouted"),
  bringup-board's next item. Found on the way: checks.ts -> fluidnc.ts -> grblhal.ts -> checks.ts read the signal
  list before it was set when grblhal.ts loaded first (firmware-log.test.ts); the list now lives in cnc/signals.ts.
- 27 Nov, gap 2 (what the agents must write): the scripted CNC hand-wrote nine parts' nets that no prompt explained and
  almost no check caught. A probe took each part's nets out in turn. The jack's (no 24 V), the e-stop plug's loop (an
  e-stop that can never trip) and the UART TX resistor's (drivers never read back) left no violation at all. The motor
  plugs, the spindle's MOSFET and its terminal gave only "connected to nothing", with no hint which net. Fix, in code
  (src/cnc/wiring-auto.ts, applied by the contract tools on every CNC parts, pins, rails or cnc write, missing nets
  only): the board's nets are the hand-wired design's, pin for pin. The mock now writes the CNC parts bare, as an agent
  would, and the parts prompt says the tools wire them. Found on the way: the power tree finds the brick by the jack's
  VIN, so on a bare jack it never ran (U8.VCC on no net); the wiring now goes first. `--no-hardware` mocks of both CNC
  briefs: adopt UNSETTLED rev 9 with 1 violation (space-slack, 100×80) → settled rev 12 with 0 (80×64, 2% over its
  smallest).
- 27 Nov, gap 2 (pins): each scripted pin left out in turn. The driver checks named the whole entry, but grblHAL's
  and FluidNC's missing-signal check named 7 signals with only "with its part's pin" (ESTOP_TRIP, the three limits,
  STEPPER_UART, STEPPER_UART_TX, SPINDLE_PWM), and nothing asked for the UART's 1 kΩ TX resistor itself. Fix
  (src/cnc/signal-ends.ts): every missing signal is listed with its partRef and partPin, found by role (the motors' by
  the drivers' axis order). With no TX resistor, the check names the part to add (0402WGF1001TCE, its pin2 on
  @STEPPER_UART).
- 27 Nov, gap 2 (parts): each scripted part left out in turn. A missing jack, motor plug, spindle terminal or MOSFET
  was silent. A missing spindle gate driver or enable gate showed only as a stray net or a request for ENN pins. A
  missing first limit plug moved every axis' limit onto the next plug. Fix: the plugs the machine decides (jack, one
  per motor, spindle terminal, e-stop plug, one limit plug per axis) are added in code, as an arm's are
  (cnc/wiring-auto.ts withCncPlugs, then the wiring), and the three chips nothing asked for are named by role and part
  (cnc/checks.ts). The mock now writes no plugs. `--no-hardware` mocks of both briefs: settled rev 12, 0 violations,
  all eleven plugs from code (413 s and 469 s).
- 27 Nov, real run 1 (out/real-runs/cc-cnc-1, the user's yes: briefs/cnc.md on the Claude subscription, --no-hardware,
  plan rp-d26a63259ed3): UNSETTLED at revision 26, 4 violations, 33 min, 10.06 M input tokens (5.04 M cache reads),
  0.31 M output, $0 (API-equivalent $6.20). The agents chose the ESP32-WROOM-32E and FluidNC, one Y motor. It ran on
  a35e1cf2, which had lost the gap-2 work by accident (restored in 839b50bc), so there were no auto plugs or wiring.
  Lessons → fixes:
  - the firmware's signal list was the scripted gantry's (Y1/Y2): it now comes from the machine's motors
    (signals.ts cncSignals), and the grblHAL map's M3 and the sim's moves follow;
  - cnc-parts rewrote cnc 5 times guessing screw and rail names: the message lists the catalog's names;
  - track-width-narrow on VMOT/VMOT_SW: the architect rated VMOT 10 A on the 6.67 A brick, so a cnc-supply check flags
    a motor rail rated past cnc.input;
  - TX straight onto PDN_UART with no resistor (seen in the replay): flagged, with the 1 kΩ named;
  - the CNC's signal names are now in the parts prompt.
  Replaying the final contract: 1 of 4 gone, 3 with exact fixes, 6 missing plugs added by code, TX caught.
  `--no-hardware` mock: settled rev 12, 0 violations, 359 s.
- 27 Nov, the full mock of briefs/cnc.md with every build (adopt 5c26ea71, the default time limit): SETTLED at
  revision 12, 0 violations, 23.6 min. The board was built at revisions 11 and 12 on 4 layers, DRC 0 errors and 0
  unconnected (24 silk warnings), 80×65 mm. grblHAL compiles for the STM32F411, and the simulated machine (grblHAL in
  Renode) passes in 21 s. The path there: the 30-min cap had cut the board off (fixed: the run waits for a build still
  running, 22e23aa6); the grblHAL brief had been designed on the ESP32 (16420eb2); and the motor rails were too narrow
  (bringup-board's 4b13b385 and 5c26ea71).
- 27 Nov, real run 2 (out/real-runs/cc-cnc-2, the user's yes: briefs/cnc.md on the Claude subscription with every
  build, plan rp-7100c8acbe63): UNSETTLED at revision 26, 1 violation (rail-unwired 5V), the board held, 84 min (60
  plus the build grace), 9.89 M input and 0.38 M output tokens, $0 (API-equivalent $6.77). It was 4 violations in run
  1. Boards were built DRC-clean three times. The gap-2 completion and the run-1 lessons held. Lessons → fixes:
  - both runs ended at the 25-revision budget, because only motion got a robot's 40: the budget now follows the
    design's kind (contract/design-kind.ts), and the end-of-budget drain waits the same 45-min build grace (it was 15);
  - the architect's 5V rail (net V5V) and the power tree's buck (V5) never met, which cost 4 revisions: a code-made
    supply net joins the contract's one rail at its voltage that nothing else feeds (never VBUS, the cell, the brick or a
    servo rail; the Eurobot fixture's VBUS caught a first version that would have shorted it);
  - the plan said 2-7 min (from rovers and loggers): the estimate is now per kind, and says when no run of that kind has
    settled yet;
  - grblHAL picked on the ESP32 reached the mechanics engineer as a broken simulation: now one finding ("grblHAL builds
    for the STM32F4: set fluidnc or move to the STM32F411"), and the sim reports not run;
  - the run's board build kept running after the run exited: run()'s children are now killed with their process group
    on exit.
- 28 Nov, FluidNC built (gap 11's second half, after the user's yes to the download): its pinned pioarduino platform
  55.03.39 installed for the wifi env in 3 min, +2.86 GB in ~/.platformio (the estimate was 1-2 GB: the precompiled
  ESP-IDF libraries alone are 1.94 GB unpacked; Bringup's own espressif32@8.0.0 core is untouched). `pio run -e wifi`
  in a copy of tools/FluidNC: SUCCESS in 87 s, RAM 20.9 %, flash 97.1 % of FluidNC's app partition. Two traps on the
  way: its build flags call `python git-version.py` (no `python` outside the venv: put .venv/bin on PATH) and the
  script needs the clone's .git. The board's config.yaml is not compiled in: FluidNC reads it from LittleFS
  (FluidNC/data). Still open: the firmware builder building FluidNC for a fluidnc machine (today it builds Bringup's
  Arduino product firmware and writes config.yaml beside it), and flashing a real ESP32.
- 28 Nov, real run 3 (out/real-runs/cc-cnc-3, the user's yes: briefs/cnc.md, now pinned to grblHAL on an STM32F411,
  b86ed425; every build): UNSETTLED at revision 28 with 0 violations, held by the board and one pending change, at the
  60-min cap; 13.87 M input and 0.60 M output tokens, $0 (API-equivalent $10.35). grblHAL in Renode passed (30 s),
  the first real run to prove the simulated machine. The board never built (revisions 14-28): the Freerouting
  fallback wrote the catalog jack's footprint as its name ("dc091a250"), and tscircuit refused it. That's
  bringup-board's fix (a connector's footprint skipped Bringup's own land patterns). Lessons → fixes (mine):
  - the agents read that refusal as theirs and proposed a stand-in footprint 5 times: a build error Bringup caused (a
    catalog footprint the router can't read, a supplier lookup) is left out of what an agent sees, and wakes no one
    when nothing else is left (agents/code-faults.ts);
  - the architect grew the board 100×80 → 140×100 for power-plane widths on a layout that never built: the plane check
    skips a board whose build failed;
  - the plan said "other kinds' 2-7 min": the estimate reads out/real-runs as well.
- 28 Nov, the machine's own firmware as a build kind (machinefw; lead-2: "firmware compiles" must mean the machine's
  firmware). Before, a CNC run built grblHAL only inside the simulation and FluidNC never, and the report's "Firmware:
  compiles" was Bringup's Arduino app. Now src/tools/machine-fw.ts builds what the machine runs: grblHAL's STM32F4xx
  board build from the generated map (env bringup_cnc), or FluidNC's wifi build in a copy of tools/FluidNC with the
  board's config.yaml in its LittleFS image (FluidNC/data, `-t buildfs`). It reports RAM and flash, says "not run"
  without the clone or platform, and sends a failed build to the architect and the mechanics engineer (machine-fw). The
  app firmware line is labelled as such on a CNC. Measured in test/machine-fw.int.test.ts: grblHAL 8 s, FluidNC about
  113 s (RAM 20.9 %, flash 97.1 %). One FluidNC attempt failed in 11 s while another PlatformIO build ran beside it
  (the reason wasn't captured): to watch in runs, where the app firmware builds alongside.
