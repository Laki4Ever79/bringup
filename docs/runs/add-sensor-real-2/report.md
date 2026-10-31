# Bringup report

Status: UNSETTLED at contract revision 39
Violations: 0

## Design
- Pocket BLE temperature/humidity logger with USB-C charging/flashing, one wake button, status LED blink on wake, separate hardware charge indication, and temperature/humidity sensing on a single-cell Li-ion battery.
- Board 50×30 mm; connectors: J1 usb-c on bottom, SW1 button on right
- Parts: U1 ESP32-C3-MINI-1 (C2838502), U2 SHT40-AD1B-R2 (C2909890), U3 AP2112K-3.3TRG1 (C51118), U4 TP4054-42-SOT25R (C32574), J1 TYPE-C-31-M-12 (C165948), J2 S2B-PH-K-S(LF)(SN) (C173752), D1 KT-0603R (C2286), D2 KT-0603R (C2286), R1 0402WGF1001TCE (C11702), C1 CL05B104KO5NNNC (C1525), SW1 TS-1187A-B-A-B (C318884)
- Pins: USB_DN=GPIO18→J1.DN, USB_DP=GPIO19→J1.DP, LED_STATUS=GPIO8→D1.K, BUTTON=GPIO3→SW1.A, I2C_SDA=GPIO6→U2.SDA, I2C_SCL=GPIO7→U2.SCL
- Rails (peak/rated): VBUS 500/500 mA, average 0 mA; VBAT 250/500 mA, average 0 mA; 3V3 150/300 mA, average 0.246 mA
- Estimated battery life: 69 days vs target 90 days

## Change requests

| Request | Fields changed | Woken | Consistent again | After it |
|---|---|---|---|---|
| add a temperature/humidity sensor | requirements, parts | architect, parts, build:board, build:enclosure, build:firmware, grounding, consistency (7 of 9; 1 more checked, no change: firmware) | 78.8 s | then 3 review rounds changed requirements, rails, parts, pins, behavior |

## Brief review

Verdict: fail after 6 reviews (at most 2 fix rounds).
- Review 1 of revision 9: fail
  - blocker (requirements, rails, parts, behavior): The 3-month battery-life requirement is not plausibly met. The contract gives no part-level active average, and the deterministic battery-life check from the stated duty cycle bounds wake current using the busiest battery-fed rail peak: 3 s awake every 60 s at up to 500 mA gives 25 mA average, so 500 mAh / 25 mA / 24 h ≈ 0.83 days. Even using the 3V3 rail peak only, 160 mA × 3/60 = 8 mA average, so life would be about 500/8/24 ≈ 2.6 days before sleep/LDO current. The contract's 0.111 mA average implies about 186 days, but that average is unsupported by the stated 3 s active BLE window and no active-current average is provided to justify it. Suggestion: Provide a realistic active-current average for the ESP32-C3 during the 3 s wake/advertise interval, or reduce active time/current enough that the computed average stays at or below about 0.231 mA total for 90 days from 500 mAh.
  - blocker (requirements, rails, parts): Operation from a single Li-ion cell is undermined by the 3.3 V LDO choice. The power simulation shows the 3V3 rail falls out of regulation at 3.5 V battery input, producing only 3.122 V, so the design does not maintain its intended supply over much of a Li-ion discharge. A 1-cell Li-ion beacon expected to run for months must tolerate normal battery droop well below 3.5 V. Suggestion: Use a regulator topology that remains in regulation across the intended Li-ion voltage range, or power the MCU from a rail specification compatible with the cell's discharge curve and the MCU's allowed supply range.
  - major (requirements, parts, pins, behavior): The brief requires a status LED that blinks briefly each wake and shows charging state. This design uses two LEDs: D1 for wake status and separate D2 for charging state. That can satisfy the user-visible intent, but it does not match the singular phrasing 'A status LED ... and shows charging state.' Suggestion: If the product intent is one LED total, combine wake blink and charge indication onto a single LED; otherwise confirm the amended brief allows separate status and charge LEDs.
- Review 2 of revision 19: fail
  - blocker (requirements, rails, parts, behavior): Battery-life requirement is not met as designed. The brief requires at least 3 months on ~500 mAh, but the supplied power budget estimates only 63 days from the stated rail averages, and the duty-cycle-based check gives 25 days using the contract's own 100 ms active / 60 s period and peak current upper bound. Suggestion: Reduce average current enough to reach <=0.231 mA total for 90 days from 500 mAh, and provide a realistic average-active-current budget for the ESP32-C3 BLE wake/advertise cycle rather than relying on peak loads or inconsistent rail averages.
  - major (parts, requirements, pins): The design includes U2 SHT40 sensor and related I2C connections even though the brief says sensors are out of scope for this product. Suggestion: Remove the sensor and its I2C wiring unless there is an explicit change request adding sensing; this will also help battery life.
  - major (parts, rails, requirements): The 3.3 V rail is out of regulation when the Li-ion cell falls to 3.5 V in the provided simulation (3.122 V output). A single-cell Li-ion spends substantial time below full charge, so this choice works against reliable BLE beacon operation over the discharge curve. Suggestion: Use a regulator or power architecture that maintains the MCU supply across the intended battery voltage range, or justify that the ESP32-C3 and all required functions meet the brief over the reduced rail voltage.
  - minor (behavior, requirements): The contract behavior block is inconsistent with the actual product firmware description: behavior.blinkMs is 100 ms, but product firmware blinks the status LED for 20 ms and ignores the behavior field. Suggestion: Align the contract behavior fields with the shipped firmware behavior so the wake blink requirement is specified unambiguously.
- Review 3 of revision 29: fail
  - blocker (requirements, parts, pins): The design includes U2 SHT40 sensor hardware even though sensors are explicitly out of scope in the brief. Suggestion: Remove U2 and its SENSOR_SDA/SENSOR_SCL pin assignments, leaving a pure BLE beacon design.
  - blocker (requirements, behavior): Battery-life requirement is not plausibly met as documented. The contract says 20 ms active every 60 s, but the deterministic check states the firmware wake is 80 ms total (30 ms reading + 50 ms BLE advertising), and using the provided upper-bound method gives 0.273 mA average and about 76 days from 500 mAh, below the 90-day requirement. Suggestion: Align the contract duty-cycle numbers to the actual firmware and reduce wake energy enough to get under about 0.231 mA average for 90 days on 500 mAh, or increase battery capacity if the brief permits.
  - major (requirements, behavior): The brief requires pressing the button to make the beacon show up on the phone right away, but the listed firmware behavior after a wake is only 50 ms of BLE advertising. That is a very short discovery window and clearly works against immediate detection unless the phone is already scanning at exactly that moment. Suggestion: On button wake, advertise for a substantially longer interval or stay connectable long enough to make immediate phone discovery plausible.
  - major (rails, behavior, requirements): The 3.3 V rail falls out of regulation at 3.5 V battery input in the provided simulation, yet the product is powered from a single Li-ion cell whose voltage spends much of its discharge below that. This risks BLE/MCU operation over a significant portion of the battery and works against both the 3-month life target and reliable beacon behavior. Suggestion: Use a regulator or supply strategy that maintains MCU operating voltage over the intended Li-ion discharge range, or justify direct battery operation if the MCU and LED behavior permit it.
  - minor (requirements, behavior): The contract's status LED behavior fields are inconsistent with the product firmware notes: the contract says blinkMs 100, while the firmware description says the status LED blinks 20 ms on each wake and the product build ignores behavior fields. Suggestion: Update the contract behavior to match the product firmware so the requirement is traceable and reviewable.
- Review 1 of revision 31: fail
  - blocker (requirements, pins, behavior): The amended brief requires a temperature/humidity sensor, but the firmware facts state the product build has no sensor because it lacks I2C_SDA/I2C_SCL pins, so it reads and stores nothing and reports 'no sensor' over BLE. Although U2 exists in parts and sensor pins appear in the contract, the built behavior does not meet the added requirement. Suggestion: Make the product firmware use the contracted SENSOR_SDA/SENSOR_SCL pins and read/store the SHT40 on wake so the built device actually provides temperature/humidity sensing.
  - blocker (requirements, rails, behavior, parts): Battery life does not meet the 3-month requirement by the provided duty-cycle-based check. Using the given wake profile: 80 ms awake every 60 s at up to 200 mA plus 6 µA sleep/quiescent gives about 0.273 mA average, so 500 mAh / 0.273 mA / 24 h ≈ 76 days, below the 90-day target. The contract's 20 ms active time is also inconsistent with the stated firmware wake of 30 ms sensor reading + 50 ms BLE advertising. Suggestion: Reduce wake energy and/or increase interval so the computed average is ≤ about 0.231 mA for 90 days from 500 mAh; for example shorten awake time, reduce peak draw during wake, or advertise/read less often while keeping the brief behavior.
  - major (rails, parts): The 3.3 V rail is out of regulation from the Li-ion cell at 3.5 V in the provided power-path simulation, producing only 3.122 V. A single-cell Li-ion spends significant time below that, so this choice works against reliable operation over the battery discharge range and can undermine the intended battery runtime/usable capacity. Suggestion: Use a regulator with sufficiently low dropout at the actual peak current, reduce peak current enough that dropout is acceptable, or power the MCU from a rail architecture that maintains valid voltage across the intended Li-ion range.
  - minor (requirements, parts, connectors): The brief asks for a status LED that blinks on wake and shows charging state. The design appears to meet this via D1 as status LED and a separate hardware charge LED in the requirements summary, but D2 is not explicitly connected in the contract pins, so charge-state indication depends on implicit charger wiring not described here. Suggestion: Document the D2-to-U4.CHRG charge LED connection explicitly in the contract or generated wiring so the charging-state requirement is unambiguous.
- Review 2 of revision 34: fail
  - blocker (pins, parts, behavior, requirements): The amended brief requires a temperature/humidity sensor, but the firmware/build facts say the design has no sensor support: it reports no I2C_SDA/I2C_SCL pins, reads nothing on wake, stores nothing, and exposes 'no sensor' over BLE. Although U2 is present in parts and SDA/SCL are listed in the contract, the delivered design as built/firmware cannot meet the added sensor requirement. Suggestion: Make the delivered firmware and pin mapping actually use U2 on GPIO6/7 as I2C, take readings on wake, and store/report them so the design truly includes temperature/humidity sensing.
  - blocker (requirements, rails, behavior): The 3-month battery-life requirement is not met by the computed battery-life check. Using the provided wake behavior, average current is 0.246 mA, giving about 85 days from 500 mAh, below the 90-day target. The stated 408-day estimate relies on the contract's 15 ms active time and 0.05 mA average rail figure, but the firmware facts say each wake is 80 ms (30 ms reading + 50 ms BLE advertising), so the contract average is not plausible as delivered. Suggestion: Reduce active energy or increase battery capacity so the computed average falls to 0.231 mA or less for 90 days on 500 mAh. For example, shorten awake/advertising time, reduce wake frequency, or use a lower-power implementation validated against the actual firmware behavior.
  - major (rails, parts, behavior, requirements): The battery-life estimate also omits connection time after a phone connects. The firmware can stay awake up to 30 s per connection, and the brief explicitly expects a phone to connect. Leaving this out makes the claimed average optimistic and works against the 3-month requirement. Suggestion: Include a realistic connection-duty assumption in the power budget, or redesign so connection sessions are very infrequent/short and still comfortably meet 90 days.
  - major (rails, parts): The power-path simulation shows the 3V3 rail dropping to 3.208 V at a 3.5 V Li-ion input because the chosen LDO is in dropout. A single-cell Li-ion spends substantial time below nominal voltage, so this choice risks reduced usable battery capacity and undermines the battery-life target even further. Suggestion: Use a regulator with lower dropout at the required peak current, or power the MCU from a rail strategy that preserves regulation deeper into battery discharge.
- Review 3 of revision 39: fail
  - blocker (requirements, rails, parts, behavior): Battery-life requirement is not met as designed. The brief requires at least 3 months on one Li-ion cell, judged against about 500 mAh. Deterministic checks compute only 69 days from the contract rail averages: 500 mAh / (0.246 mA on 3V3 + 0.055 mA LDO IQ) / 24 = about 69 days. The duty-cycle-based upper-bound check is worse at about 53 days: 80 ms active every 60 s at up to 250 mA gives 0.333 mA active average, plus 0.005 mA sleep and 0.055 mA LDO IQ = 0.393 mA, so 500 / 0.393 / 24 = about 53 days. The firmware also allows up to 30 s connected-awake time, which is excluded from that average and can only reduce life further. Suggestion: Reduce average current enough to reach 90 days on 500 mAh, or amend the duty cycle/parts accordingly. For example, use a much lower-Iq regulator or no always-on LDO, lower wake current and/or wake duration, and account for connection energy in the budget.
  - major (requirements, parts, pins, behavior): The brief says pressing the button makes it show up on the phone right away. The firmware note says the button wakes the device early from deep sleep, but the contract does not explicitly state immediate advertising behavior on button press; advertising cadence in the brief is 'about once a minute' otherwise. While the product-build firmware description implies wake then normal wake actions, this requirement is important enough that it is at risk unless immediate advertise-on-button is explicit. Suggestion: State in the contract/behavior that a button press wakes the MCU and immediately starts BLE advertising, not merely waits for the next periodic interval.

## Artifacts
- Board: out/add-sensor-real-2/board/rev-39/dist/board/kicad/board.kicad_pcb (render out/add-sensor-real-2/board/rev-39/board.png)
- Design rules (KiCad, JLCPCB 2-layer): 2 errors, 100 warnings, 0 unconnected (silk_over_copper 55, lib_footprint_issues 24, text_height 19, hole_clearance 2, silk_overlap 2); 1 rule: USB-C vendor land pattern (J1): pad ↔ its own locating hole ≥ 0.15 mm
- Enclosure: out/add-sensor-real-2/enclosure/rev-37/case.stl
- Print files: out/add-sensor-real-2/enclosure/rev-37/case.stl, out/add-sensor-real-2/enclosure/rev-37/lid.stl
- Print check: ok (case open side up, lid plate down; 4 M2 standoffs for self-tapping screws)
- Firmware: compiles
- Firmware boot (QEMU): booted, printed revision 39; SENSOR FAIL is expected: QEMU emulates no I2C sensor
- Firmware simulation (Wokwi): not run yet (npm run bringup -- simulate <run>)
- Sourcing: 10/11 listed at LCSC/JLCPCB · 10 stock unknown (jlcsearch returned none) · 1 not checked (J2: no live data)

## Fabrication

JLCPCB assembly package (PCBWay takes the same files) in out/add-sensor-real-2/board/rev-39/fab:
- README.txt (2215 bytes)
- bom.csv (616 bytes)
- cpl.csv (556 bytes)
- gerbers.zip (67119 bytes)

Work through the checklist in README.txt before ordering.

## Coordination
- Contract changes: 39
- Change requests held by interception: 9 (approved 8, rejected 1)
- Consistency checks: 53; violations caught along the way: 112
- Artifacts built: 35; failed builds: 1; agent crashes: 0

## Environment
```
tscircuit: tools/node/node_modules/.bin/tsci
KiCad 10:  docker
python:    .venv/bin/python
pio:       .venv/bin/pio
QEMU:      tools/qemu/bin/qemu-system-riscv32
Wokwi:     tools/wokwi-cli/wokwi-cli (token set)
```
