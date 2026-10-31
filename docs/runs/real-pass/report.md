# Bringup report

Status: settled at contract revision 19
Violations: 0

## Design
- Pocket BLE beacon with USB-C charging and flashing, one wake button, status LED, and dedicated hardware charging indicator; no sensors.
- Board 50×30 mm; connectors: J1 usb-c on bottom, SW1 button on right
- Parts: U1 ESP32-C3-MINI-1 (C2838502), U3 XC6206P332MR-G (C5446), U4 TP4054-42-SOT25R (C32574), J1 TYPE-C-31-M-12 (C165948), J2 S2B-PH-K-S(LF)(SN) (C173752), D1 KT-0603R (C2286), D2 KT-0603R (C2286), R1 0402WGF1001TCE (C11702), R2 0402WGF1001TCE (C11702), SW1 TS-1187A-B-A-B (C318884), C1 CL10A106KP8NNNC (C19702)
- Pins: BUTTON=GPIO0→SW1.A, LED_STATUS=GPIO1→D1.A
- Rails (peak/rated): VBAT 500/500 mA, average 0.012 mA; 3V3 84/200 mA, average 0.077 mA
- Estimated battery life: 231 days vs target 90 days

## Brief review

Verdict: pass after 2 reviews (at most 4 fix rounds).
- Review 1 of revision 13: fail
  - blocker (behavior, requirements, parts): The brief requires a status LED that blinks briefly each wake and shows charging state. This design uses two separate LEDs: D1 as the wake/status LED and D2 as a dedicated charge LED. The contract summary even calls out a separate hardware charging indicator. That does not meet the stated requirement for one status LED serving both functions. Suggestion: Use a single LED for both indications, with charging-state drive arranged through the charger/output and firmware blinking on wake, or amend the brief via change request if two LEDs are acceptable.
  - major (requirements, rails, behavior, parts): The 3-month battery target is plausible for the idle beacon schedule, but the stated rail averages are not self-consistent with the described firmware activity. Contract averages sum to 0.125 mA total, while the duty-cycle check from datasheet currents gives about 0.09 mA before adding LED blink and other awake currents. Also, connected time up to 30 s is explicitly excluded from the average. This does not prove failure, but the battery claim as documented is under-specified for real use after button press/phone connection. Suggestion: State the expected connection frequency/duration in the battery requirement and align the rail averages with the firmware-derived budget including LED current, charger leakage, and any expected connected-use duty cycle.
  - minor (connectors, outline, requirements): The board meets the stated 50 × 30 mm target exactly, and USB-C and button openings are placeable, but there is no margin beyond the nominal size for enclosure tolerances. Suggestion: If mechanical robustness matters for the printed case, consider leaving small outline margin inside the approximately 50 × 30 mm target.
- Review 2 of revision 19: pass
  - minor (requirements, parts, behavior): The contract summary says 'status LED, and dedicated hardware charging indicator' and the design uses two separate LEDs (D1 status LED plus D2 charge LED). This still meets the brief requirement that a status LED blinks on wake and shows charging state, but it does so with an added dedicated charge LED rather than one LED serving both roles. Suggestion: Keep as-is if two LEDs are acceptable for the prototype; if board area or BOM cost matters later, consider combining wake blink and charge indication onto one LED while preserving the required behaviors.

## Artifacts
- Board: <run>/board/rev-19/dist/board/kicad/board.kicad_pcb (render <run>/board/rev-19/board.png)
- Design rules (KiCad, JLCPCB 2-layer): 2 errors, 88 warnings, 0 unconnected (silk_over_copper 52, lib_footprint_issues 20, text_height 15, hole_clearance 2, silk_overlap 1); 1 rule: USB-C vendor land pattern (J1): pad ↔ its own locating hole ≥ 0.15 mm
- Enclosure: <run>/enclosure/rev-19/case.stl
- Print files: <run>/enclosure/rev-19/case.stl, <run>/enclosure/rev-19/lid.stl
- Print check: ok (case open side up, lid plate down; 4 M2 standoffs for self-tapping screws)
- Firmware: compiles
- Firmware boot (QEMU): booted, printed revision 19
- Firmware simulation (Wokwi): not run yet (npm run bringup -- simulate <run>)
- Sourcing: 11/11 listed at LCSC/JLCPCB · 11 stock unknown (jlcsearch returned none)

## Fabrication

JLCPCB assembly package (PCBWay takes the same files) in <run>/board/rev-19/fab:
- README.txt (2249 bytes)
- bom.csv (516 bytes)
- cpl.csv (475 bytes)
- gerbers.zip (57783 bytes)

Work through the checklist in README.txt before ordering.

## Coordination
- Contract changes: 19
- Change requests held by interception: 5 (approved 5, rejected 0)
- Consistency checks: 20; violations caught along the way: 5
- Artifacts built: 15; failed builds: 0; agent crashes: 0

## Environment
```
tscircuit: <repo>/tools/node/node_modules/.bin/tsci
KiCad 10:  docker
python:    <repo>/.venv/bin/python
pio:       <repo>/.venv/bin/pio
QEMU:      <repo>/tools/qemu/bin/qemu-system-riscv32
Wokwi:     <repo>/tools/wokwi-cli/wokwi-cli (token set)
```
