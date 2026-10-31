# Briefs

A brief is what a product person would write: what the device does, the constraints and what's out of scope. It names
no pins and no part numbers. Agents turn it into the design contract.

| Brief | Use it for | What it exercises |
|---|---|---|
| `logger.md` | The demo and full runs | Every domain at once: an I2C sensor (pins, nets, firmware), a USB-C connector (board edge plus enclosure cutout), a status LED (a pin the first plan tends to miss, so the firmware agent requests it through change control), a battery-life target (power rail budget and the SPICE check), the 50 × 30 mm outline (board and enclosure must agree), and in-stock parts (catalog plus live JLCPCB stock). |
| `beacon.md` | The "add a sensor" demo | A BLE beacon with USB-C charging, a battery, a status LED and a wake button, and no sensor. Then ask for "add a temperature/humidity sensor": parts adds the SHT40, the architect its I2C pins, and the board, firmware and case (a vent over the sensor) follow. Scripted runs build a fixed beacon design for it. |
| `blinky.md` | Fast test runs and smoke checks | The smallest design that still touches board, enclosure and firmware: one MCU, one LED pin, one USB-C cutout. No sensor and no battery, so there are fewer parts to place and route and fewer agent turns. |

Run one with `npm run bringup -- briefs/<name>.md --mock` (no API key needed) or without `--mock` to use real models.
