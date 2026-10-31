# Bringup report

Status: UNSETTLED at contract revision 38
Violations: 0

## Design
- Pocket battery-powered climate logger with temperature/humidity sensing, BLE access from a phone, USB-C charging and flashing, status indication, and on-module flash history storage.
- Board 50×30 mm; connectors: J1 usb-c on bottom, SW1 button on top
- Parts: U1 ESP32-C3-MINI-1 (C2838502), U2 SHTC3-TR-2.5KS (C194656), U3 XC6206P332MR-G (C5446), U4 TP4054-42-SOT25R (C32574), J1 TYPE-C-31-M-12 (C165948), J2 S2B-PH-K-S(LF)(SN) (C173752), D1 KT-0603R (C2286), R1 0402WGF1001TCE (C11702)
- Pins: I2C_SCL=GPIO4→U2.SCL, I2C_SDA=GPIO6→U2.SDA, STATUS_LED=GPIO8→D1.A, USB_DN=GPIO18→J1.DN, USB_DP=GPIO19→J1.DP
- Rails (peak/rated): VBAT 500/500 mA, average 0.002 mA; VBUS 500/500 mA; 3V3 120/200 mA, average 0.112 mA
- Estimated battery life: 181 days vs target 180 days

## Change requests

| Request | Fields changed | Woken | Consistent again | After it |
|---|---|---|---|---|
| edited pins.h: I2C_SDA GPIO5 → GPIO6 | pins, parts | architect, parts, firmware, build:board, build:firmware, grounding, consistency (7 of 9) | 584.6 s | no review yet |

## Brief review

No verdict: the design never reached the reviewer (it did not become consistent and quiet).

## Artifacts
- Board: out/file-sync-real/board/rev-38/dist/board/kicad/board.kicad_pcb (render out/file-sync-real/board/rev-38/board.png)
- Design rules (KiCad, JLCPCB 2-layer): 2 errors, 94 warnings, 0 unconnected (silk_over_copper 53, lib_footprint_issues 21, text_height 16, hole_clearance 2, hole_to_hole 2, silk_overlap 2); 1 rule: USB-C vendor land pattern (J1): pad ↔ its own locating hole ≥ 0.15 mm
- Enclosure: not built
- Firmware: compiles
- Firmware boot (QEMU): booted, printed revision 38; SENSOR FAIL is expected: QEMU emulates no I2C sensor
- Sourcing: 8/8 listed at LCSC/JLCPCB · 2 stock confirmed · 6 stock unknown (jlcsearch returned none)
- enclosure failed: enclosure build failed: enclosure: J1: cutout top 16.70 mm reaches the lid's lip (starts at 11.00 mm)

## Fabrication

JLCPCB assembly package (PCBWay takes the same files) in out/file-sync-real/board/rev-38/fab:
- README.txt (2208 bytes)
- bom.csv (547 bytes)
- cpl.csv (498 bytes)
- gerbers.zip (58829 bytes)

Work through the checklist in README.txt before ordering.

## Coordination
- Contract changes: 38
- Change requests held by interception: 29 (approved 17, rejected 12)
- Consistency checks: 44; violations caught along the way: 53
- Artifacts built: 15; failed builds: 5; agent crashes: 0

## Environment
```
tscircuit: tools/node/node_modules/.bin/tsci
KiCad 10:  docker
python:    .venv/bin/python
pio:       .venv/bin/pio
QEMU:      tools/qemu/bin/qemu-system-riscv32
```
