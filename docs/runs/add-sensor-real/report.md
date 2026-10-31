# Bringup report

Status: UNSETTLED at contract revision 29
Violations: 0

## Design
- Pocket BLE beacon with periodic BLE advertising, connectable by phone, USB-C charging and flashing, one button to wake and advertise immediately, and status LED indication.
- Board 50×30 mm; connectors: J1 usb-c on bottom, SW1 button on right
- Parts: U1 ESP32-C3-MINI-1 (C2838502), U2 SHTC3-TR-2.5KS (C194656), U3 XC6206P332MR-G (C5446), U4 TP4054-42-SOT25R (C32574), J1 TYPE-C-31-M-12 (C165948), J2 S2B-PH-K-S(LF)(SN) (C173752), D1 KT-0603R (C2286), D2 KT-0603R (C2286), R1 0402WGF1001TCE (C11702), SW1 TS-1187A-B-A-B (C318884), C1 CL05A105KA5NQNC (C52923), C2 CL10A106KP8NNNC (C19702)
- Pins: STATUS_LED=GPIO2→D1.K, BUTTON_WAKE=GPIO9→SW1.A, USB_DN=GPIO18→J1.DN, USB_DP=GPIO19→J1.DP
- Rails (peak/rated): VBUS 500/500 mA; VBAT 0/500 mA, average 0 mA; 3V3 120/200 mA, average 0.0433 mA
- Estimated battery life: 470 days vs target 8 days

## Change requests

| Request | Fields changed | Woken | Consistent again | After it |
|---|---|---|---|---|
| add a temperature/humidity sensor | parts, requirements, pins, rails | architect, parts, firmware, build:board, build:enclosure, build:firmware, grounding, consistency (8 of 9) | 133.5 s | then 2 review rounds changed requirements, rails, parts, pins, behavior |

## Brief review

Verdict: fail after 4 reviews (at most 1 fix round).
- Review 1 of revision 8: fail
  - blocker (requirements, rails, parts, behavior): The 3-month battery-life requirement is not plausibly met. The contract claims 90 days and lists very low rail averages, but the duty-cycle-based check using the stated 300 ms awake every 60 s gives 2.51 mA average and about 8 days from 500 mAh. Calculation: 500 mA peak for 0.3 s each 60 s => 500*0.3/60 = 2.5 mA average while awake, plus 5 µA sleep and 1 µA LDO IQ. Even if 500 mA is an upper bound, the design provides no justified active average current low enough to reach 90 days; to hit 90 days on 500 mAh needs about 0.231 mA total average, so the 300 ms wake would need only about 45 mA average during wake ((0.231-0.006)mA*60/0.3), and connected sessions up to 30 s would worsen it further. Suggestion: Provide a realistic active-current budget for the ESP32-C3 during wake/advertising and any connected state, or choose a much lower-power BLE platform / shorter wake time / longer interval so the computed average current credibly stays at or below about 0.231 mA for 90 days on 500 mAh.
  - major (requirements, behavior): The stated firmware behavior does not match the brief because it says 'on each wake it reads the sensor' and advertises sensor/history data, while the brief explicitly puts sensors out of scope for this product. Suggestion: Remove sensor-dependent behavior from the product contract/build description and specify beacon behavior only (BLE advertising/connectability, button wake, status indication) unless and until a sensor is actually in scope.
- Review 2 of revision 14: fail
  - blocker (requirements, rails, behavior): Battery-life requirement is not met. The brief requires at least 3 months on a ~500 mAh cell, but the contract's own duty cycle is 300 ms active every 60 s. Using the provided upper-bound check: 500 mA × 0.3 s / 60 s = 2.5 mA average while awake, plus ~6 µA sleep/LDO, giving about 2.51 mA average and about 500/2.51/24 ≈ 8.3 days, not 3 months. Suggestion: Reduce wake energy dramatically or increase interval. For example, choose a much lower active current platform and/or much shorter wake/advertising window so the computed average supports ≥90 days on 500 mAh, and update the contract averages to match the duty cycle plausibly.
  - major (requirements, parts, behavior): The design contract and firmware behavior still include sensor-reading and history behavior, while the brief says sensors are out of scope for this product. The supplied firmware facts say each wake 'reads the sensor' and stores readings/history, which is not part of a BLE beacon and suggests the delivered behavior is for a different product template. Suggestion: Remove sensor/history behavior from the product requirements/firmware for this beacon revision, keeping only BLE advertising/connectability, button wake, charging indication, and status blink behavior required by the brief.
  - major (requirements, parts, pins, behavior): Charging-state LED indication is not plausibly implemented. The brief requires a status LED that also shows charging state, but the only assigned LED in pins is D1 on MCU GPIO2. Charger U4 exposes CHRG, and there is a second LED D2 part present, but no pin/net assignment or stated behavior connects an LED to CHRG or otherwise defines how charging state is shown, so this requirement is at risk. Suggestion: Explicitly implement charging indication, e.g. wire D2 (with resistor) to U4.CHRG or define an MCU-readable charger-status path and corresponding behavior, and reflect that in pins/behavior.
- Review 1 of revision 20: fail
  - blocker (requirements, rails, behavior): The 3-month battery-life requirement is not met by the stated duty cycle and power budget. The brief needs at least ~90 days from a 500 mAh cell, but the contract states batteryLifeDays: 8, and the duty-cycle-based check gives about 2.51 mA average: 500 mA × 0.3 s / 60 s = 2.5 mA while awake, plus ~0.006 mA sleep/LDO, for about 500 mAh / 2.506 mA / 24 ≈ 8.3 days. Suggestion: Reduce active current and/or awake time drastically, or use a much lower-power BLE platform. For 90 days on 500 mAh, average current must be about 500/(90×24) ≈ 0.231 mA total, including regulator quiescent and sleep.
  - blocker (requirements, parts, pins, behavior): The design contract adds onboard temperature/humidity sensing and firmware behavior to read/store sensor data every wake, while the brief explicitly says sensors are out of scope for this prototype. Suggestion: Remove the sensor from the product contract and firmware behavior, or justify a separate variant. Keep the beacon focused on BLE, charging, LED, and button only.
  - major (requirements, behavior): The status LED wake indication is not plausibly 'brief' as required. The product firmware note says it blinks 20 ms on each wake, but the contract behavior specifies blinkMs: 1000 and tiltBlinkMs: 1000; although behavior is ignored by the product build, the contract itself does not clearly capture the intended brief blink behavior. Suggestion: Record the actual product LED behavior in the contract so it unambiguously matches the brief: a short wake blink and charging-state indication.
  - major (requirements, parts, pins): Charging-state LED indication is not clearly implemented. There are two LEDs in parts, but only D1 is assigned in pins. The charger's CHRG pin is available, yet no contract pin or behavior ties an LED to charging state. Suggestion: Explicitly assign one LED to charger status, e.g. driven from U4.CHRG or by the MCU with a defined charging-state behavior, so the brief's charging indication is clearly met.
- Review 2 of revision 29: fail
  - blocker (requirements, rails, parts, behavior): Battery-life requirement is not met. The brief requires at least 3 months on a ~500 mAh Li-ion cell, but the contract's own duty cycle and peak load imply about 34 days worst-case average life: 120 mA × 0.3 s / 60 s = 0.600 mA while awake, plus 0.005 mA sleep and 0.001 mA LDO IQ ≈ 0.606 mA average; 500 mAh / 0.606 mA / 24 ≈ 34 days. The stated rails average of 0.0433 mA is inconsistent with the peak-and-duty-cycle check, and no lower active current is justified in the contract. Suggestion: Reduce wake energy substantially or lengthen the advertising interval duty cycle so the computed average supports >=90 days. For example, use a much lower-power BLE platform or a far shorter/lower-current wake profile, and restate a consistent average-current budget.
  - major (parts, requirements, behavior): An out-of-scope sensor is included and the shipped firmware behavior explicitly reads it and stores measurement history each wake, even though the brief says sensors are out of scope for this prototype. Suggestion: Remove the sensor and sensor-driven firmware behavior from the design, or at minimum justify that it does not affect the beacon requirements or power budget.
  - major (requirements, behavior): The contract does not explicitly capture connectable BLE behavior or the button-triggered immediate advertising behavior, both of which are must-haves in the brief. The summary mentions BLE and a wake button, but the formal behavior only lists LED blink fields unrelated to the product build, while product firmware details live outside the contract. Suggestion: State in the contract behavior/requirements that advertising occurs about once per minute, accepts a connection, and a button press wakes the device to advertise immediately.

## Artifacts
- Board: out/add-sensor-real/board/rev-29/dist/board/kicad/board.kicad_pcb (render out/add-sensor-real/board/rev-29/board.png)
- Design rules (KiCad, JLCPCB 2-layer): 0 errors, 90 warnings, 0 unconnected (silk_over_copper 52, lib_footprint_issues 21, text_height 16, silk_overlap 1); 1 rule: USB-C vendor land pattern (J1): pad ↔ its own locating hole ≥ 0.15 mm
- Enclosure: out/add-sensor-real/enclosure/rev-29/case.stl
- Print files: out/add-sensor-real/enclosure/rev-29/case.stl, out/add-sensor-real/enclosure/rev-29/lid.stl
- Print check: ok (case open side up, lid plate down; 4 M2 standoffs for self-tapping screws)
- Firmware: compiles
- Firmware boot (QEMU): booted, printed revision 29
- Sourcing: 12/12 listed at LCSC/JLCPCB · 2 stock confirmed · 10 stock unknown (jlcsearch returned none)

## Fabrication

JLCPCB assembly package (PCBWay takes the same files) in out/add-sensor-real/board/rev-29/fab:
- README.txt (2147 bytes)
- bom.csv (567 bytes)
- cpl.csv (495 bytes)
- gerbers.zip (59543 bytes)

Work through the checklist in README.txt before ordering.

## Coordination
- Contract changes: 29
- Change requests held by interception: 12 (approved 10, rejected 2)
- Consistency checks: 36; violations caught along the way: 48
- Artifacts built: 27; failed builds: 1; agent crashes: 0

## Environment
```
tscircuit: tools/node/node_modules/.bin/tsci
KiCad 10:  docker
python:    .venv/bin/python
pio:       .venv/bin/pio
QEMU:      tools/qemu/bin/qemu-system-riscv32
```
