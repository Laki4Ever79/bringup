# Bringup report

Status: settled at contract revision 10
Violations: 0

## Design
- BLE beacon with a wake button and temperature/humidity sensing
- Board 50×30 mm; connectors: J1 usb-c on left, SW1 button on top
- Parts: U1 ESP32-C3-MINI-1 (C2838502), U3 AP2112K-3.3TRG1 (C51118), U4 TP4054-42-SOT25R (C32574), J1 TYPE-C-31-M-12 (C165948), J2 S2B-PH-K-S(LF)(SN) (C173752), D1 KT-0603R (C2286), D2 KT-0603R (C2286), R1 0402WGF1001TCE (C11702), R2 0402WGF5101TCE (C25905), R3 0402WGF5101TCE (C25905), R4 0402WGF4701TCE (C25900), R7 0402WGF1001TCE (C11702), C1 CL05A105KA5NQNC (C52923), C2 CL05A105KA5NQNC (C52923), C3 CL10A106KP8NNNC (C19702), SW1 TS-1187A-B-A-B (C318884), U2 SHT40-AD1B-R2 (C2909890), R5 0402WGF1002TCE (C25744), R6 0402WGF1002TCE (C25744)
- Pins: BUTTON=GPIO3→SW1.A, STATUS_LED=GPIO10→D1.A, I2C_SDA=GPIO8→U2.SDA, I2C_SCL=GPIO9→U2.SCL
- Rails (peak/rated): 3V3 120/600 mA, average 0.1475 mA
- Estimated battery life: 103 days vs target 90 days

## Change requests

| Request | Fields changed | Woken | Consistent again | After it |
|---|---|---|---|---|
| add a temperature/humidity sensor | requirements, parts, pins | architect, parts, build:board, build:enclosure, build:firmware, grounding, consistency (7 of 9; 1 more checked, no change: firmware) | 195.1 s | then 1 review round changed nothing |

## Brief review

Verdict: pass after 2 reviews (at most 1 fix round).
- Review 1 of revision 7: pass
  - minor (rails, parts): The AP2112K draws about 55 µA quiescent: over 6 months that alone is about 242 mAh of the 500 mAh cell. Suggestion: Consider a low-Iq LDO (about 1 µA) to leave margin for the radio and the sensor.
- Review 1 of revision 10: pass
  - minor (rails, parts): The AP2112K draws about 55 µA quiescent: over 6 months that alone is about 242 mAh of the 500 mAh cell. Suggestion: Consider a low-Iq LDO (about 1 µA) to leave margin for the radio and the sensor.

## Artifacts
- Board: out/add-sensor/board/rev-10/dist/board/kicad/board.kicad_pcb (render out/add-sensor/board/rev-10/board.png)
- Design rules (KiCad, JLCPCB 2-layer): 0 errors, 94 warnings, 0 unconnected (silk_over_copper 53, lib_footprint_issues 23, text_height 18); 1 rule: USB-C vendor land pattern (J1): pad ↔ its own locating hole ≥ 0.15 mm
- Enclosure: out/add-sensor/enclosure/rev-9/case.stl
- Print files: out/add-sensor/enclosure/rev-9/case.stl, out/add-sensor/enclosure/rev-9/lid.stl
- Print check: ok (case open side up, lid plate down; 4 M2 standoffs for self-tapping screws)
- Firmware: compiles
- Firmware boot (QEMU): booted, printed revision 10; SENSOR FAIL is expected: QEMU emulates no I2C sensor
- Sourcing: 19/19 at LCSC/JLCPCB · stock not checked (mock run)

## Fabrication

JLCPCB assembly package (PCBWay takes the same files) in out/add-sensor/board/rev-10/fab:
- README.txt (2082 bytes)
- bom.csv (632 bytes)
- cpl.csv (542 bytes)
- gerbers.zip (61644 bytes)

Work through the checklist in README.txt before ordering.

## Coordination
- Contract changes: 10
- Change requests held by interception: 1 (approved 1, rejected 0)
- Consistency checks: 18; violations caught along the way: 33
- Artifacts built: 10; failed builds: 0; agent crashes: 0

## Environment
```
tscircuit: tools/node/node_modules/.bin/tsci
KiCad 10:  docker
python:    .venv/bin/python
pio:       .venv/bin/pio
QEMU:      tools/qemu/bin/qemu-system-riscv32
```
