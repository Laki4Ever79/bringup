# Bringup report

Status: settled at contract revision 8
Violations: 0

## Design
- BLE temperature and humidity logger
- Board 50×30 mm; connectors: J1 usb-c on left
- Parts: U1 ESP32-C3-MINI-1 (C2838502), U2 SHT40-AD1B-R2 (C2909890), U3 AP2112K-3.3TRG1 (C51118), U4 TP4054-42-SOT25R (C32574), J1 TYPE-C-31-M-12 (C165948), J2 S2B-PH-K-S(LF)(SN) (C173752), D1 KT-0603R (C2286), D2 KT-0603R (C2286), R1 0402WGF1001TCE (C11702), R2 0402WGF5101TCE (C25905), R3 0402WGF5101TCE (C25905), R4 0402WGF4701TCE (C25900), R5 0402WGF1002TCE (C25744), R6 0402WGF1002TCE (C25744), R7 0402WGF1001TCE (C11702), C1 CL05A105KA5NQNC (C52923), C2 CL05A105KA5NQNC (C52923), C3 CL10A106KP8NNNC (C19702)
- Pins: I2C_SDA=GPIO4→U2.SDA, I2C_SCL=GPIO9→U2.SCL, STATUS_LED=GPIO10→D1.A
- Rails (peak/rated): 3V3 120/600 mA, average 0.0375 mA
- Estimated battery life: 225 days vs target 180 days

## Change requests

| Request | Fields changed | Woken | Consistent again | After it |
|---|---|---|---|---|
| edited pins.h: I2C_SDA GPIO8 → GPIO4 | pins | architect, build:board, build:firmware, grounding, consistency (5 of 9; 2 more checked, no change: parts, firmware) | 96.3 s | then 1 review round changed nothing |

## Brief review

Verdict: pass after 2 reviews (at most 1 fix round).
- Review 1 of revision 7: pass
  - minor (rails, parts): The AP2112K draws about 55 µA quiescent: over 6 months that alone is about 242 mAh of the 500 mAh cell. Suggestion: Consider a low-Iq LDO (about 1 µA) to leave margin for the radio and the sensor.
- Review 1 of revision 8: pass
  - minor (rails, parts): The AP2112K draws about 55 µA quiescent: over 6 months that alone is about 242 mAh of the 500 mAh cell. Suggestion: Consider a low-Iq LDO (about 1 µA) to leave margin for the radio and the sensor.

## Artifacts
- Board: out/file-sync-1/board/rev-8/dist/board/kicad/board.kicad_pcb (render out/file-sync-1/board/rev-8/board.png)
- Design rules (KiCad, JLCPCB 2-layer): 0 errors, 88 warnings, 0 unconnected (silk_over_copper 49, lib_footprint_issues 22, text_height 17); 1 rule: USB-C vendor land pattern (J1): pad ↔ its own locating hole ≥ 0.15 mm
- Enclosure: out/file-sync-1/enclosure/rev-4/case.stl
- Print files: out/file-sync-1/enclosure/rev-4/case.stl, out/file-sync-1/enclosure/rev-4/lid.stl
- Print check: ok (case open side up, lid plate down; 4 M2 standoffs for self-tapping screws)
- Firmware: compiles
- Firmware boot (QEMU): booted, printed revision 8; SENSOR FAIL is expected: QEMU emulates no I2C sensor
- Sourcing: 18/18 at LCSC/JLCPCB · stock not checked (mock run)

## Fabrication

JLCPCB assembly package (PCBWay takes the same files) in out/file-sync-1/board/rev-8/fab:
- README.txt (2130 bytes)
- bom.csv (586 bytes)
- cpl.csv (525 bytes)
- gerbers.zip (62541 bytes)

Work through the checklist in README.txt before ordering.

## Coordination
- Contract changes: 8
- Change requests held by interception: 1 (approved 1, rejected 0)
- Consistency checks: 14; violations caught along the way: 7
- Artifacts built: 7; failed builds: 0; agent crashes: 0

## Environment
```
tscircuit: tools/node/node_modules/.bin/tsci
KiCad 10:  docker
python:    .venv/bin/python
pio:       .venv/bin/pio
QEMU:      tools/qemu/bin/qemu-system-riscv32
```
