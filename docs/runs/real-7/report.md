# Bringup report

Status: UNSETTLED at contract revision 38
Violations: 0

## Design
- Pocket battery-powered BLE climate logger with USB-C charging and firmware flashing for a single-cell Li-ion battery, onboard status LED that blinks on each reading and indicates charging state, temperature/humidity sensing for periodic history logging, and a 3-pin UART programming header.
- Board 50×30 mm; connectors: J1 usb-c on bottom, SW1 button on right
- Parts: U1 ESP32-C3-MINI-1 (C2838502), U2 SHT40-AD1B-R2 (C2909890), U3 AP2112K-3.3TRG1 (C51118), U4 TYPE-C-31-M-12 (C165948), D1 KT-0603R (C2286), SW1 TS-1187A-B-A-B (C318884)
- Pins: I2C_SDA=GPIO4→U2.SDA, I2C_SCL=GPIO5→U2.SCL, STATUS_LED=GPIO8→D1.A, BOOT_BUTTON=GPIO9→SW1.A, USER_BUTTON=GPIO10→SW1.B
- Rails (peak/rated): VBUS 250/500 mA, average 0 mA; VBAT 500/1000 mA, average 0.015 mA; VSYS_3V3 90/300 mA, average 0.345 mA
- Estimated battery life: 50 days vs target 180 days

## Brief review

Verdict: fail after 3 reviews (at most 2 fix rounds).
- Review 1 of revision 6: fail
  - blocker (parts, connectors, pins, requirements): The contract does not include any Li-ion charging IC or battery connector/protection path, even though the brief requires USB-C for charging a single-cell Li-ion battery. A USB-C receptacle alone does not provide charging. Suggestion: Add a single-cell Li-ion charger/power-path implementation and a battery connector/path in the contract, with the necessary USB-C CC resistors and battery/VBUS connections.
  - blocker (parts, connectors, pins, requirements): The contract claims USB firmware flashing, but there is no USB-UART bridge and no native-USB MCU. The ESP32-C3-MINI-1 pin list used here exposes no USB D+/D- pins, and the contract does not map J1 DP/DN to anything, so firmware flashing over USB-C is not plausibly met. Suggestion: Use a MCU/module with supported native USB brought to the USB-C connector, or add a USB-UART bridge with the required boot/reset circuitry and pin mappings for flashing.
  - major (requirements, rails, parts): The 6-month battery-life claim is not credibly supported by the stated averages. The computed 251 days uses only 0.028 mA on 3V3 plus 55 µA LDO IQ, but omits any explicit average for the ESP32-C3 BLE activity and sensor conversions. Using the provided duty cycle and the busiest-rail peak gives a worst-case 0.27 mA active contribution; adding 20 µA sleep and 55 µA LDO gives about 0.345 mA average, or about 500/0.345/24 = 60 days, far short of 180 days. Without a justified lower active average for BLE logging/advertising, the brief is at risk. Suggestion: Provide a realistic average-current budget for the MCU BLE behavior, sensor read, LED blink, and any charger/status circuitry, and choose lower-power parts or longer intervals if needed to credibly exceed 180 days.
  - major (parts, pins, requirements): There is only one LED part, but the brief requires a status LED that both blinks on each reading and shows charging state. With no charger IC and no charging-status output defined, the charging-state indication is not implemented. Suggestion: Add charger circuitry with a status output and define how the LED is driven to indicate both measurement activity and charge state, or add a second LED if needed.
  - minor (connectors, parts): A USB-C device intended to work with a normal cable needs the standard CC termination, but no CC resistors or controller are listed in the contract. This may simply be omitted from the high-level contract, but as written the USB-C interface details are incomplete. Suggestion: Explicitly include the required USB-C CC pull-down implementation in the parts/connectivity so the port is guaranteed to behave as a sink with ordinary USB-C cables.
- Review 2 of revision 23: fail
  - blocker (requirements): The contract states batteryLifeDays = 60, but the brief requires at least 6 months on a ~500 mAh cell. Sixty days is far short of the stated must-have. Suggestion: Revise the design target and contract to meet at least ~180 days battery life on a 500 mAh cell, and make the power budget explicitly support that requirement.
  - major (requirements, rails, parts): The battery-life justification is not credible as written. The computed estimate of 298 days comes from only 0.015 mA average on 3.3 V plus 55 µA LDO quiescent current, while ignoring any average current for the ESP32-C3 BLE activity and the sensor's periodic measurements. Using the provided duty cycle and the busiest 3.3 V rail peak, the check itself says the active contribution could be as high as 0.27 mA average; adding 0.055 mA IQ and 0.020 mA sleep gives about 0.345 mA total, which is about 500/0.345/24 ≈ 60 days. That aligns with the contract's 60-day target, not the 6-month brief. Suggestion: Provide a realistic average-current budget including ESP32-C3 sleep current, BLE advertising/connection bursts, sensor conversion current, LED blink energy, and regulator losses/quiescent current, then redesign if needed to reach >=180 days.
  - blocker (connectors, parts, pins, requirements): USB-C is required for charging and for flashing firmware, but the contract does not include any USB-UART bridge, native USB-capable MCU, or pin assignments for D+ / D-. The ESP32-C3-MINI-1 can support USB Serial/JTAG on specific pins, but no such pins are assigned and the USB connector's DP/DN are not connected in the contract. As written, firmware flashing over USB-C is not plausibly met. Suggestion: Define a complete USB flashing path in the contract: either route USB D+/D- to the MCU's native USB pins with the required boot/reset scheme, or add a USB-UART bridge and connect it to the programming interface.
  - blocker (parts, requirements, rails): USB-C charging is a must-have, but there is no Li-ion charger IC in the parts list or any described charge/power-path circuitry. A USB-C receptacle plus LDO does not implement battery charging. Suggestion: Add a single-cell Li-ion charger IC and the required supporting circuitry, and describe how VBUS charges the cell while powering the system safely.
  - major (requirements, parts, pins): The brief requires the status LED to blink on each reading and show charging state. The contract includes only one MCU-driven LED with no charger/status part or signal defined that could indicate charging state. Without charger status output or equivalent logic, charging-state indication is not supported by the hardware as described. Suggestion: Choose a charger with a status output and route it to the LED or MCU, or otherwise define hardware that allows the LED to indicate charging state as well as measurement blinks.
- Review 3 of revision 38: fail
  - blocker (requirements, rails, parts): The 6-month battery-life requirement is not met by the stated power budget. The computed average battery current is 0.015 mA (VBAT) + 0.345 mA (3V3 rail loads) + 0.055 mA LDO quiescent = 0.415 mA, which gives about 500/0.415/24 = 50 days, far short of the required 180 days. The brief explicitly requires at least 6 months on a ~500 mAh cell with readings every few minutes. Suggestion: Reduce average current to about 500 mAh / (180*24 h) = 0.116 mA total or less, including regulator quiescent. That likely requires a much lower-sleep-current BLE MCU/power architecture and/or a lower-Iq regulator, and the contract should state rail averages consistent with the claimed duty cycle.
  - major (requirements, rails, parts): The stated duty-cycle assumptions do not support the listed 3.3 V rail average. With 150 ms active every 300 s, even assuming the busiest rail peak of 90 mA during all active time, the active contribution is only 90 * 0.150/300 = 0.045 mA; adding the stated 20 µA sleep gives about 0.065 mA, or at the checker's bound 'at most 0.27 mA average if active at the busiest rail's peak'. This conflicts with the contract's 0.345 mA average on VSYS_3V3, so the battery-life claim is internally inconsistent and at risk. Suggestion: Provide a consistent average-current budget per mode and per part, including BLE advertising/connection intervals, sensor conversion time, LED pulse current and duration, and MCU sleep current, then update the rail averages and battery-life figure accordingly.
  - blocker (requirements, connectors, parts, pins): The brief requires USB-C for charging and for flashing firmware so no special cable is needed, but the contract only names a USB-C receptacle plus a separate 3-pin UART programming header in the summary, with no USB-UART interface, no native USB-capable MCU part exposed in the pin mapping, and no USB D+/D- connectivity defined to the MCU. As specified, firmware flashing over USB-C is not plausibly supported. Suggestion: Define a complete USB flashing path over the USB-C connector: either use the MCU's native USB with D+/D- routed and boot/program control handled, or add a USB-UART bridge and the required routing/signals. Remove reliance on a special UART header if the brief's 'no special cable' requirement is to be met.
  - blocker (requirements, parts, rails, pins): Charging from USB-C is required, but there is no Li-ion charger IC or battery-management part in the contract. The listed parts include an MCU, sensor, LDO, USB-C receptacle, LED, and button only. A USB-C connector alone does not charge a single-cell Li-ion battery. Suggestion: Add a single-cell Li-ion charging IC and the associated power-path/battery connector components, and reflect them in parts, rails, and pins so USB-C charging is actually implemented.
  - major (requirements, parts, pins): The status LED must blink on each reading and show charging state. The contract provides only one LED driven from an MCU GPIO, but no charger/status output or other means for the LED to indicate charging state while powered/charging independently of firmware. Without a defined charger or status signal, the charging-state portion of the requirement is not plausibly met. Suggestion: Use a charger IC with a charge-status output and wire the LED, or a second LED/control scheme, so charging indication is defined in hardware as well as the MCU blink-on-reading behavior.

## Artifacts
- Board: out/real-7/board/rev-38/dist/board/kicad/board.kicad_pcb (render out/real-7/board/rev-38/board.png)
- Enclosure: out/real-7/enclosure/rev-38/case.stl
- Firmware: compiles
- Firmware boot (QEMU): booted, printed revision 36

## Fabrication

JLCPCB assembly package (PCBWay takes the same files) in out/real-7/board/rev-38/fab:
- README.txt (2103 bytes)
- bom.csv (408 bytes)
- cpl.csv (286 bytes)
- gerbers.zip (45598 bytes)

Work through the checklist in README.txt before ordering.

## Coordination
- Contract changes: 38
- Change requests held by interception: 18 (approved 10, rejected 8)
- Consistency checks: 54; violations caught along the way: 130
- Artifacts built: 35; failed builds: 13; agent crashes: 0

## Environment
```
tscircuit: tools/node/node_modules/.bin/tsci
KiCad 10:  docker
python:    .venv/bin/python
pio:       .venv/bin/pio
QEMU:      tools/qemu/bin/qemu-system-riscv32
```
