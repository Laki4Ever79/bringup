# Brief: climate logger on an STM32, wired

## What we want
A small battery-powered logger that records temperature and humidity, built on an **STM32** (we already flash STM32s
over SWD on our line). It keeps its readings in its own memory; we read them out over the programming port when we
collect the units. No wireless: the units go into metal cabinets.

## Must have
- **Temperature and humidity sensing.** Room-grade accuracy: about ±0.2 °C and ±2 %RH.
- **Runs on one Li-ion cell for at least a year** with a reading every 5 minutes. Assume around 500 mAh.
- **USB-C** for charging.
- **A status LED** that blinks briefly on each reading.
- **Small.** About 50 × 30 mm.

## Out of scope
- Bluetooth, Wi-Fi, a display, buttons, a cloud backend.

## How we'll judge the first prototype
It charges over USB-C, it logs a reading every 5 minutes, and the readings look sane next to a reference thermometer.
