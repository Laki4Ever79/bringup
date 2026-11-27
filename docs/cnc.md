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
